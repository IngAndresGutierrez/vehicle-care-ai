import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import { generateConfirmationToken } from "@/infra/tokens";
import type { IntegrationSource } from "@/integrations/ports/workshop";
import { appError, type AppError } from "../errors";
import { applyJourneyEventInTx, findJourney } from "../journey/journey-store";
import { runInTransaction } from "../transaction";
import { authorizeVehicleAccess } from "../vehicle-access";
import { activeOwnerId, audit, externalServiceCode, INTENT_TTL_MINUTES, journeyActor, journeyErrorToApp, precheckJourney, workshopErrorToApp, type BookingDeps } from "./common";

export interface PreparedBooking {
  intentId: string;
  /** Token en claro: se entrega solo aquí, una vez, para el clic del propietario. Nunca se persiste ni se registra. */
  confirmationToken: string;
  expiresAt: Date;
  requiresUserConfirmation: true;
  summary: { serviceCode: string; workshopId: string; workshopName: string; slotRef: string; startsAt: Date; totalCop: number; taxCop: number; source: IntegrationSource };
  /** true: reintento de la misma preparación; el token anterior quedó invalidado y se emite uno nuevo. */
  reissued: boolean;
}

/**
 * Prepara la reserva sin reservar (AGENT_DESIGN.md §4.3): crea una BookingIntent con expiración y un token de
 * confirmación de un solo uso. Solo el clic humano (confirmBooking) puede convertirla en reserva.
 */
export async function prepareBooking(
  deps: BookingDeps,
  cmd: { actor: ActorContext; vehicleId: string; serviceCode: string; quoteId: string; slotRef: string; traceId: string; idempotencyKey: string },
): Promise<Result<PreparedBooking, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  const access = await authorizeVehicleAccess(db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;
  const key = { vehicleId: cmd.vehicleId, serviceCode: cmd.serviceCode };
  const eventKey = `intent:${cmd.idempotencyKey}`;

  // Reintento: se reemite el token (el anterior deja de servir) en vez de crear otra intención.
  const previous = await db.journeyEvent.findUnique({ where: { idempotencyKey: eventKey } });
  if (previous) return reissueToken(deps, (previous.payload as { intentId: string }).intentId, cmd.vehicleId);

  // Antes que la FSM: con una reserva activa el journey está en BOOKED y el error útil es este, no el de estado.
  const active = await db.booking.findFirst({ where: { vehicleId: cmd.vehicleId, serviceCode: cmd.serviceCode, status: { in: ["PENDING", "CONFIRMED"] } } });
  if (active) return err(appError("ACTIVE_BOOKING_EXISTS", undefined, { refs: { bookingId: active.id } }));

  const pre = await precheckJourney(db, key, { type: "BOOKING_INTENT_CREATED", intentId: "precheck" }, journeyActor(cmd.actor));
  if (!pre.ok) return pre;

  const quote = await db.quote.findUnique({ where: { id: cmd.quoteId } });
  if (!quote || quote.vehicleId !== cmd.vehicleId || quote.serviceCode !== cmd.serviceCode || pre.value.context.activeQuoteId !== quote.id) {
    return err(appError("QUOTE_MISMATCH"));
  }
  if (quote.status !== "ACTIVE" || !quote.validUntil || quote.validUntil.getTime() <= now.getTime()) {
    if (quote.status === "ACTIVE") await db.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });
    return err(appError("QUOTE_EXPIRED", undefined, { refs: { nextStep: "REQUOTE" } }));
  }

  const mapping = await externalServiceCode(db, quote.workshopId, cmd.serviceCode);
  if (!mapping) return err(appError("INVALID_INPUT", "SERVICE_NOT_OFFERED_BY_WORKSHOP"));
  const slot = await workshop.getSlot({ workshopRef: mapping.workshopRef, slotRef: cmd.slotRef });
  if (!slot.ok) return err(workshopErrorToApp(slot.error));
  if (slot.data.remaining <= 0 || slot.data.startsAt.getTime() <= now.getTime()) return err(appError("SLOT_CONFLICT"));

  const customerId = await activeOwnerId(db, cmd.vehicleId, now);
  if (!customerId) return err(appError("UNAUTHORIZED", "NO_ACTIVE_OWNERSHIP"));
  const workshopRow = await db.workshop.findUniqueOrThrow({ where: { id: quote.workshopId } });
  const { token, hash } = generateConfirmationToken();
  const expiresAt = new Date(Math.min(now.getTime() + INTENT_TTL_MINUTES * 60_000, quote.validUntil.getTime()));

  return runInTransaction<PreparedBooking, AppError>(db, async (tx) => {
    const intent = await tx.bookingIntent.create({
      data: {
        confirmationTokenHash: hash,
        vehicleId: cmd.vehicleId,
        customerId,
        serviceCode: cmd.serviceCode,
        quoteId: quote.id,
        slotExternalRef: cmd.slotRef,
        slotStartsAt: slot.data.startsAt,
        workshopId: quote.workshopId,
        requestedById: cmd.actor.actorId,
        expiresAt,
        traceId: cmd.traceId,
        createdAt: now,
      },
    });
    const applied = await applyJourneyEventInTx(tx, {
      ...key,
      event: { type: "BOOKING_INTENT_CREATED", intentId: intent.id },
      actor: journeyActor(cmd.actor),
      traceId: cmd.traceId,
      idempotencyKey: eventKey,
    });
    if (!applied.ok) return err(journeyErrorToApp(applied.error));
    await audit(tx, {
      actor: cmd.actor,
      action: "BOOKING_INTENT_PREPARED",
      entityType: "BookingIntent",
      entityId: intent.id,
      details: { quoteId: quote.id, slotRef: cmd.slotRef, expiresAt: expiresAt.toISOString(), source: slot.source },
      traceId: cmd.traceId,
      at: now,
    });
    return ok({
      intentId: intent.id,
      confirmationToken: token,
      expiresAt,
      requiresUserConfirmation: true as const,
      summary: {
        serviceCode: cmd.serviceCode,
        workshopId: quote.workshopId,
        workshopName: workshopRow.name,
        slotRef: cmd.slotRef,
        startsAt: slot.data.startsAt,
        totalCop: quote.totalCop ?? 0,
        taxCop: quote.taxCop ?? 0,
        source: slot.source,
      },
      reissued: false,
    });
  });
}

/**
 * Recuperación (Fase 8C): si la respuesta con el token de confirmación se perdió (caída del proceso, sesión renovada),
 * reemite el token de la intención PENDIENTE del journey con el mismo mecanismo que un reintento idempotente: no crea
 * otra intención ni cambia el estado, y el token anterior deja de servir. Solo para el propietario titular.
 */
export async function reissuePendingIntent(deps: BookingDeps, cmd: { actor: ActorContext; vehicleId: string; serviceCode: string }): Promise<Result<PreparedBooking, AppError>> {
  if (cmd.actor.role !== "OWNER") return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  const access = await authorizeVehicleAccess(deps.db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", deps.clock.now());
  if (!access.ok) return access;
  const journey = await findJourney(deps.db, { vehicleId: cmd.vehicleId, serviceCode: cmd.serviceCode });
  const intentId = journey?.state === "AWAITING_CONFIRMATION" ? journey.context.pendingIntentId : null;
  if (!intentId) return err(appError("NOT_FOUND", "NO_PENDING_INTENT"));
  return reissueToken(deps, intentId, cmd.vehicleId);
}

async function reissueToken(deps: BookingDeps, intentId: string, vehicleId: string): Promise<Result<PreparedBooking, AppError>> {
  const { db, clock } = deps;
  const now = clock.now();
  const intent = await db.bookingIntent.findUnique({ where: { id: intentId }, include: { quote: true } });
  if (!intent || intent.vehicleId !== vehicleId) return err(appError("IDEMPOTENCY_MISMATCH"));
  if (intent.status !== "AWAITING_USER") return err(appError("INTENT_INVALIDATED", intent.status));
  if (intent.expiresAt.getTime() <= now.getTime()) return err(appError("INTENT_EXPIRED"));
  const journey = await findJourney(db, { vehicleId, serviceCode: intent.serviceCode ?? "" });
  if (journey?.context.pendingIntentId !== intent.id) return err(appError("INTENT_INVALIDATED", "JOURNEY_MOVED_ON"));

  const { token, hash } = generateConfirmationToken();
  const updated = await db.bookingIntent.updateMany({ where: { id: intent.id, status: "AWAITING_USER" }, data: { confirmationTokenHash: hash } });
  if (updated.count !== 1) return err(appError("INTENT_INVALIDATED"));
  const workshopRow = await db.workshop.findUniqueOrThrow({ where: { id: intent.workshopId } });
  return ok({
    intentId: intent.id,
    confirmationToken: token,
    expiresAt: intent.expiresAt,
    requiresUserConfirmation: true,
    summary: {
      serviceCode: intent.serviceCode ?? "",
      workshopId: intent.workshopId,
      workshopName: workshopRow.name,
      slotRef: intent.slotExternalRef,
      startsAt: intent.slotStartsAt,
      totalCop: intent.quote.totalCop ?? 0,
      taxCop: intent.quote.taxCop ?? 0,
      source: intent.quote.source as IntegrationSource,
    },
    reissued: true,
  });
}
