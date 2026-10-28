import type { BookingFailureCode } from "@/domain/journey";
import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import { hashToken } from "@/infra/tokens";
import type { IntegrationSource, WsBooking, WsResult } from "@/integrations/ports/workshop";
import { appError, type AppError, type AppErrorCode } from "../errors";
import { applyJourneyEventInTx, findJourney } from "../journey/journey-store";
import { openHumanCaseInTx } from "../open-human-case";
import { runInTransaction } from "../transaction";
import { authorizeVehicleAccess } from "../vehicle-access";
import { activeOwnerId, audit, BOOKING_SERVICE_ACTOR, journeyErrorToApp, type BookingDeps } from "./common";

/** Intentos de reconciliación fallidos antes de escalar a un humano (D-36, provisional). */
export const MAX_RECONCILIATION_ATTEMPTS = 3;

export type ConfirmBookingResult =
  | {
      status: "CONFIRMED";
      bookingId: string;
      folio: string;
      startsAt: Date;
      workshopId: string;
      totalCop: number;
      source: IntegrationSource;
      duplicate: boolean;
    }
  | { status: "PENDING_RECONCILIATION"; bookingId: string; duplicate: boolean; escalatedCaseId: string | null };

type WorkshopOutcome =
  | { kind: "CONFIRMED"; folio: string; startsAt: Date }
  | { kind: "FAILED"; code: BookingFailureCode; raw?: string }
  | { kind: "UNCERTAIN"; raw?: string };

/**
 * Confirmación explícita de una reserva (AGENT_DESIGN.md §4.3, ADR-017).
 *
 * Fase A (transacción): token → actor humano autorizado → titularidad → journey (no SAFETY_ESCALATED, intención
 * pendiente correcta) → intención vigente → cotización vigente → sin reserva activa → Booking PENDING (clave
 * idempotente por intención) e intención CONSUMED.
 * Fase B: solicitud al taller (MOCK) fuera de transacción, que revalida cupo y cotización de forma atómica.
 * Fase C (transacción): CONFIRMED con folio + BOOKING_CONFIRMED, o FAILED + BOOKING_FAILED. Si el resultado
 * es incierto la reserva queda PENDING para reconciliación: no se confirma ni se reintenta a ciegas.
 */
export async function confirmBooking(
  deps: BookingDeps,
  cmd: { actor: ActorContext; confirmationToken: string; traceId: string },
): Promise<Result<ConfirmBookingResult, AppError>> {
  const { db, clock } = deps;
  const now = clock.now();

  if (typeof cmd.confirmationToken !== "string" || cmd.confirmationToken.length < 20) return err(appError("INVALID_TOKEN"));
  const intent = await db.bookingIntent.findUnique({ where: { confirmationTokenHash: hashToken(cmd.confirmationToken) } });
  if (!intent || !intent.customerId || !intent.serviceCode) return err(appError("INVALID_TOKEN"));

  // Solo humanos: el propietario autenticado o un asesor con acceso al vehículo.
  if (cmd.actor.role === "SYSTEM_AGENT" || cmd.actor.role === "SYSTEM_JOB") return err(appError("AGENT_CANNOT_CONFIRM"));
  if (cmd.actor.role !== "OWNER" && cmd.actor.role !== "ADVISOR") return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  const access = await authorizeVehicleAccess(db, cmd.actor, intent.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;
  if (cmd.actor.role === "OWNER" && cmd.actor.customerId !== intent.customerId) return err(appError("UNAUTHORIZED", "TOKEN_NOT_ISSUED_FOR_ACTOR"));

  const key = { vehicleId: intent.vehicleId, serviceCode: intent.serviceCode };
  type PhaseA = { kind: "SUBMIT"; bookingId: string } | { kind: "EXISTING"; bookingId: string } | { kind: "TERMINATED"; code: AppErrorCode };

  const phaseA = await runInTransaction<PhaseA, AppError>(db, async (tx) => {
    const fresh = await tx.bookingIntent.findUniqueOrThrow({ where: { id: intent.id }, include: { booking: true, quote: true } });
    if (fresh.booking) return ok({ kind: "EXISTING", bookingId: fresh.booking.id });

    const journey = await findJourney(tx, key);
    if (journey?.state === "SAFETY_ESCALATED") return err(appError("SAFETY_ESCALATED"));
    if (fresh.status === "REJECTED" || fresh.status === "CONSUMED") return err(appError("INTENT_INVALIDATED"));
    if (fresh.status === "EXPIRED") return err(appError("INTENT_EXPIRED"));

    if (fresh.expiresAt.getTime() <= now.getTime()) {
      await tx.bookingIntent.update({ where: { id: fresh.id }, data: { status: "EXPIRED" } });
      if (journey?.context.pendingIntentId === fresh.id) {
        const applied = await applyJourneyEventInTx(tx, { ...key, event: { type: "INTENT_EXPIRED", intentId: fresh.id }, actor: BOOKING_SERVICE_ACTOR, traceId: cmd.traceId, idempotencyKey: `intent-expired:${fresh.id}` });
        if (!applied.ok) return err(journeyErrorToApp(applied.error));
      }
      return ok({ kind: "TERMINATED", code: "INTENT_EXPIRED" });
    }
    if (journey?.state !== "AWAITING_CONFIRMATION" || journey.context.pendingIntentId !== fresh.id) {
      return err(appError("INTENT_INVALIDATED", "JOURNEY_MOVED_ON"));
    }

    if (fresh.quote.status !== "ACTIVE" || !fresh.quote.validUntil || fresh.quote.validUntil.getTime() <= now.getTime()) {
      await tx.quote.update({ where: { id: fresh.quoteId }, data: { status: "EXPIRED" } });
      await tx.bookingIntent.update({ where: { id: fresh.id }, data: { status: "REJECTED" } });
      const applied = await applyJourneyEventInTx(tx, { ...key, event: { type: "BOOKING_FAILED", intentId: fresh.id, code: "QUOTE_EXPIRED" }, actor: { actorId: cmd.actor.actorId, role: cmd.actor.role }, traceId: cmd.traceId, idempotencyKey: `quote-expired-at-confirm:${fresh.id}` });
      if (!applied.ok) return err(journeyErrorToApp(applied.error));
      return ok({ kind: "TERMINATED", code: "QUOTE_EXPIRED" });
    }

    const active = await tx.booking.findFirst({ where: { vehicleId: fresh.vehicleId, serviceCode: intent.serviceCode!, status: { in: ["PENDING", "CONFIRMED"] } } });
    if (active) return err(appError("ACTIVE_BOOKING_EXISTS", undefined, { refs: { bookingId: active.id } }));

    const booking = await tx.booking.create({
      data: {
        vehicleId: fresh.vehicleId,
        quoteId: fresh.quoteId,
        serviceCode: intent.serviceCode!,
        intentId: fresh.id,
        workshopId: fresh.workshopId,
        slotExternalRef: fresh.slotExternalRef,
        startsAt: fresh.slotStartsAt,
        status: "PENDING",
        idempotencyKey: `vc-booking:${fresh.id}`,
        source: fresh.quote.source,
        traceId: cmd.traceId,
        confirmedById: cmd.actor.actorId,
        confirmedByRole: cmd.actor.role,
        createdAt: now,
      },
    });
    await tx.bookingIntent.update({ where: { id: fresh.id }, data: { status: "CONSUMED", consumedAt: now } });
    await audit(tx, { actor: cmd.actor, action: "BOOKING_REQUESTED", entityType: "Booking", entityId: booking.id, details: { intentId: fresh.id, slotRef: fresh.slotExternalRef }, traceId: cmd.traceId, at: now });
    return ok({ kind: "SUBMIT", bookingId: booking.id });
  });

  if (!phaseA.ok) return phaseA;
  if (phaseA.value.kind === "TERMINATED") return err(appError(phaseA.value.code));
  if (phaseA.value.kind === "EXISTING") return describeBooking(deps, phaseA.value.bookingId, true);
  return submitToWorkshop(deps, phaseA.value.bookingId, cmd.traceId);
}

/** Fase B + C: solicitud idempotente al taller y aplicación del resultado. */
async function submitToWorkshop(deps: BookingDeps, bookingId: string, traceId: string): Promise<Result<ConfirmBookingResult, AppError>> {
  const booking = await deps.db.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { quote: true } });
  const workshopRow = await deps.db.workshop.findUniqueOrThrow({ where: { id: booking.workshopId } });
  const customerRef = (await deps.db.bookingIntent.findUniqueOrThrow({ where: { id: booking.intentId } })).customerId ?? "";
  const response = await deps.workshop.createBooking(
    { workshopRef: workshopRow.externalRef, slotRef: booking.slotExternalRef, externalQuoteRef: booking.quote.externalQuoteRef ?? "", customerRef, vehicleRef: booking.vehicleId },
    booking.idempotencyKey,
  );
  return applyWorkshopOutcome(deps, bookingId, toOutcome(response), traceId);
}

function toOutcome(response: WsResult<WsBooking | null>): WorkshopOutcome {
  if (response.ok) {
    if (!response.data) return { kind: "FAILED", code: "WORKSHOP_UNAVAILABLE", raw: "NOT_PROCESSED" };
    if (response.data.status !== "CONFIRMED") return { kind: "FAILED", code: "WORKSHOP_UNAVAILABLE", raw: "CANCELLED_BY_WORKSHOP" };
    return { kind: "CONFIRMED", folio: response.data.folio, startsAt: response.data.startsAt };
  }
  switch (response.error.code) {
    case "SLOT_CONFLICT":
    case "NO_SLOTS":
    case "QUOTE_EXPIRED":
      return { kind: "FAILED", code: response.error.code, raw: response.error.raw };
    case "WORKSHOP_UNAVAILABLE":
      // Rechazada sin procesar: es seguro darla por fallida.
      return { kind: "FAILED", code: "WORKSHOP_UNAVAILABLE", raw: response.error.raw };
    default:
      // Incierto (timeout) o respuesta inesperada: no suponer nada; reconciliar.
      return { kind: "UNCERTAIN", raw: response.error.raw ?? response.error.code };
  }
}

async function applyWorkshopOutcome(deps: BookingDeps, bookingId: string, outcome: WorkshopOutcome, traceId: string): Promise<Result<ConfirmBookingResult, AppError>> {
  const { db, clock } = deps;
  const now = clock.now();

  if (outcome.kind === "UNCERTAIN") {
    await audit(db, { actor: BOOKING_SERVICE_ACTOR, action: "BOOKING_OUTCOME_UNCERTAIN", entityType: "Booking", entityId: bookingId, details: { raw: outcome.raw ?? null, source: "MOCK" }, traceId, at: now });
    return describeBooking(deps, bookingId, false);
  }

  const result = await runInTransaction<{ compensateFolio: string | null; failure: AppErrorCode | null }, AppError>(db, async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (booking.status !== "PENDING") return ok({ compensateFolio: null, failure: null }); // ya aplicado (idempotente)
    const key = { vehicleId: booking.vehicleId, serviceCode: booking.serviceCode };
    const confirmer = { actorId: booking.confirmedById!, role: booking.confirmedByRole! };

    if (outcome.kind === "CONFIRMED") {
      const applied = await applyJourneyEventInTx(tx, {
        ...key,
        event: { type: "BOOKING_CONFIRMED", intentId: booking.intentId, bookingId: booking.id, externalBookingRef: outcome.folio },
        actor: confirmer,
        traceId,
        idempotencyKey: `booking-confirmed:${booking.id}`,
      });
      // El journey cambió mientras el taller procesaba (p. ej. SAFETY_SIGNAL): no se muestra como reservada; se compensa.
      if (!applied.ok) return ok({ compensateFolio: outcome.folio, failure: journeyErrorToApp(applied.error).code });
      await tx.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED", externalBookingRef: outcome.folio, startsAt: outcome.startsAt } });
      await tx.quote.update({ where: { id: booking.quoteId }, data: { status: "CONSUMED" } });
      await audit(tx, { actor: confirmer, action: "BOOKING_CONFIRMED", entityType: "Booking", entityId: booking.id, details: { folio: outcome.folio, source: booking.source }, traceId, at: now });
      return ok({ compensateFolio: null, failure: null });
    }

    await tx.booking.update({ where: { id: booking.id }, data: { status: "FAILED", failureCode: outcome.code } });
    if (outcome.code === "QUOTE_EXPIRED") await tx.quote.update({ where: { id: booking.quoteId }, data: { status: "EXPIRED" } });
    const journey = await findJourney(tx, key);
    if (journey?.context.pendingIntentId === booking.intentId) {
      const applied = await applyJourneyEventInTx(tx, {
        ...key,
        event: { type: "BOOKING_FAILED", intentId: booking.intentId, code: outcome.code },
        actor: confirmer,
        traceId,
        idempotencyKey: `booking-failed:${booking.id}`,
      });
      if (!applied.ok) return err(journeyErrorToApp(applied.error));
    }
    await audit(tx, { actor: BOOKING_SERVICE_ACTOR, action: "BOOKING_FAILED", entityType: "Booking", entityId: booking.id, details: { code: outcome.code, raw: outcome.raw ?? null, source: booking.source }, traceId, at: now });
    return ok({ compensateFolio: null, failure: outcome.code });
  });
  if (!result.ok) return result;

  if (result.value.compensateFolio) return compensate(deps, bookingId, result.value.compensateFolio, result.value.failure ?? "JOURNEY_STATE_INVALID", traceId);
  if (result.value.failure) return err(appError(result.value.failure, undefined, { refs: { bookingId } }));

  const described = await describeBooking(deps, bookingId, false);
  if (described.ok && described.value.status === "CONFIRMED") await notifyCrm(deps, bookingId, described.value.folio);
  return described;
}

/**
 * La reserva quedó creada en el taller pero el journey ya no admite confirmarla (p. ej. escalamiento de seguridad
 * durante la llamada). Se cancela en el taller y la reserva queda CANCELLED; si la cancelación falla, queda
 * PENDING con un caso humano: nunca se presenta como confirmada.
 */
async function compensate(deps: BookingDeps, bookingId: string, folio: string, reason: AppErrorCode, traceId: string): Promise<Result<ConfirmBookingResult, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  const cancelled = await workshop.cancelBooking(folio);
  if (cancelled.ok) {
    await runInTransaction(db, async (tx) => {
      await tx.booking.updateMany({ where: { id: bookingId, status: "PENDING" }, data: { status: "CANCELLED", failureCode: `COMPENSATED_${reason}` } });
      await audit(tx, { actor: BOOKING_SERVICE_ACTOR, action: "BOOKING_COMPENSATED", entityType: "Booking", entityId: bookingId, details: { folio, reason, source: cancelled.source }, traceId, at: now });
      return ok(null);
    });
    return err(appError(reason, "BOOKING_CANCELLED_AT_WORKSHOP", { refs: { bookingId } }));
  }
  const escalated = await escalate(deps, bookingId, traceId, "DATA_CONFLICT", `Reserva creada en el taller (folio ${folio}) tras un cambio del journey; la cancelación falló`);
  return err(appError(reason, "COMPENSATION_PENDING", { refs: { bookingId, ...(escalated ? { caseId: escalated } : {}) } }));
}

/**
 * Reconciliación de reservas PENDING (resultado incierto): consulta al taller por la clave de idempotencia.
 * Encontrada → se confirma; inexistente → fallida (el MOCK es síncrono, ver ADR-017); taller caído → sigue PENDING
 * y, tras MAX_RECONCILIATION_ATTEMPTS, se escala a un humano sin mover el journey.
 */
export async function reconcileBooking(
  deps: BookingDeps,
  cmd: { actor: ActorContext; bookingId: string; traceId: string },
): Promise<Result<ConfirmBookingResult, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  if (cmd.actor.role !== "SYSTEM_JOB" && cmd.actor.role !== "ADVISOR") return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  const booking = await db.booking.findUnique({ where: { id: cmd.bookingId } });
  if (!booking) return err(appError("NOT_FOUND"));
  if (cmd.actor.role === "ADVISOR") {
    const access = await authorizeVehicleAccess(db, cmd.actor, booking.vehicleId, "READ_VEHICLE", now);
    if (!access.ok) return access;
  }
  if (booking.status !== "PENDING") return describeBooking(deps, booking.id, true);

  const found = await workshop.findBooking(booking.idempotencyKey);
  await audit(db, { actor: { actorId: cmd.actor.actorId, role: cmd.actor.role }, action: "BOOKING_RECONCILIATION_ATTEMPT", entityType: "Booking", entityId: booking.id, details: { ok: found.ok, found: found.ok ? found.data !== null : null, source: found.source }, traceId: cmd.traceId, at: now });

  if (found.ok) return applyWorkshopOutcome(deps, booking.id, toOutcome(found), cmd.traceId);

  const updated = await db.booking.update({
    where: { id: booking.id },
    data: { reconciliationAttempts: { increment: 1 }, lastReconciledAt: now },
  });
  if (updated.reconciliationAttempts >= MAX_RECONCILIATION_ATTEMPTS && !updated.escalatedCaseId) {
    await escalate(deps, booking.id, cmd.traceId, "BOOKING_FAILURE", "Resultado de reserva incierto: el taller no responde a la reconciliación");
  }
  return describeBooking(deps, booking.id, false);
}

async function escalate(deps: BookingDeps, bookingId: string, traceId: string, reason: "BOOKING_FAILURE" | "DATA_CONFLICT", summary: string): Promise<string | null> {
  const now = deps.clock.now();
  const result = await runInTransaction<string, AppError>(deps.db, async (tx) => {
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (booking.escalatedCaseId) return ok(booking.escalatedCaseId);
    const opened = await openHumanCaseInTx(tx, {
      actor: BOOKING_SERVICE_ACTOR,
      vehicleId: booking.vehicleId,
      serviceCode: booking.serviceCode,
      reason,
      priority: "HIGH",
      summary,
      traceId,
      idempotencyKey: `booking-escalation:${bookingId}`,
      // La reserva puede existir en el taller: no se mueve el journey hasta que un humano lo resuelva.
      transitionJourney: false,
      now,
    });
    if (!opened.ok) return opened;
    await tx.booking.update({ where: { id: bookingId }, data: { escalatedCaseId: opened.value.caseId } });
    return ok(opened.value.caseId);
  });
  return result.ok ? result.value : null;
}

async function describeBooking(deps: BookingDeps, bookingId: string, duplicate: boolean): Promise<Result<ConfirmBookingResult, AppError>> {
  const b = await deps.db.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { quote: true } });
  switch (b.status) {
    case "CONFIRMED":
      // Nunca se presenta como confirmada una reserva sin folio emitido por el taller.
      if (!b.externalBookingRef) return err(appError("WORKSHOP_UNAVAILABLE", "MISSING_FOLIO"));
      return ok({ status: "CONFIRMED", bookingId: b.id, folio: b.externalBookingRef, startsAt: b.startsAt, workshopId: b.workshopId, totalCop: b.quote.totalCop ?? 0, source: b.source as IntegrationSource, duplicate });
    case "PENDING":
      return ok({ status: "PENDING_RECONCILIATION", bookingId: b.id, duplicate, escalatedCaseId: b.escalatedCaseId });
    case "FAILED":
      return err(appError((b.failureCode as AppErrorCode) ?? "WORKSHOP_UNAVAILABLE", undefined, { refs: { bookingId: b.id } }));
    case "CANCELLED":
      return err(appError("INTENT_INVALIDATED", b.failureCode ?? "BOOKING_CANCELLED", { refs: { bookingId: b.id } }));
  }
}

async function notifyCrm(deps: BookingDeps, bookingId: string, folio: string): Promise<void> {
  const booking = await deps.db.booking.findUniqueOrThrow({ where: { id: bookingId } });
  const customerRef = await activeOwnerId(deps.db, booking.vehicleId, deps.clock.now());
  if (!customerRef) return;
  // Mejor esfuerzo: una caída del CRM no revierte una reserva ya confirmada por el taller.
  await deps.crm.recordInteraction(
    { kind: "BOOKING_CONFIRMED", customerRef, vehicleRef: booking.vehicleId, payload: { bookingId, folio, serviceCode: booking.serviceCode } },
    `crm:booking-confirmed:${bookingId}`,
  );
}
