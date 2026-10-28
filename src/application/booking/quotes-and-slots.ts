import type { JourneyState } from "@/domain/journey";
import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Prisma } from "@/generated/prisma/client";
import type { IntegrationSource } from "@/integrations/ports/workshop";
import { appError, type AppError } from "../errors";
import { applyJourneyEventInTx } from "../journey/journey-store";
import { openHumanCaseInTx } from "../open-human-case";
import { runInTransaction } from "../transaction";
import { authorizeVehicleAccess } from "../vehicle-access";
import { audit, externalServiceCode, journeyActor, journeyErrorToApp, precheckJourney, specKeyOf, workshopErrorToApp, type BookingDeps } from "./common";

// ───────────────────────────── listWorkshops ─────────────────────────────

export interface WorkshopOption {
  workshopId: string;
  name: string;
  city: string;
}

/** Talleres activos que ofrecen el servicio. Lectura interna: no consulta sistemas externos ni mueve el journey. */
export async function listWorkshops(
  { db, clock }: Pick<BookingDeps, "db" | "clock">,
  { actor, vehicleId, serviceCode }: { actor: ActorContext; vehicleId: string; serviceCode: string },
): Promise<Result<WorkshopOption[], AppError>> {
  const access = await authorizeVehicleAccess(db, actor, vehicleId, "READ_VEHICLE", clock.now());
  if (!access.ok) return access;
  const services = await db.workshopService.findMany({
    where: { serviceCode, workshop: { isActive: true } },
    include: { workshop: true },
    orderBy: { workshop: { name: "asc" } },
  });
  return ok(services.map((s) => ({ workshopId: s.workshop.id, name: s.workshop.name, city: s.workshop.city })));
}

// ───────────────────────────── requestQuote ─────────────────────────────

export interface QuoteView {
  quoteId: string;
  workshopId: string;
  serviceCode: string;
  isEstimate: boolean;
  subtotalCop: number;
  taxCop: number;
  totalCop: number;
  taxLabel: string;
  includedItems: Array<{ description: string; qty: number }>;
  restrictions: string[];
  validUntil: Date;
  catalogVersion: string;
  source: IntegrationSource;
  journeyState: JourneyState;
  duplicate: boolean;
}

/**
 * Consulta la cotización al taller (MOCK) y la presenta (QUOTE_ISSUED → QUOTE_PRESENTED).
 * Sin precio en el catálogo: cotización UNAVAILABLE sin montos + caso humano (QUOTE_PENDING_HUMAN).
 * Si el taller no responde no se escribe nada: el error es reintentable.
 */
export async function requestQuote(
  deps: BookingDeps,
  cmd: { actor: ActorContext; vehicleId: string; serviceCode: string; workshopId: string; traceId: string; idempotencyKey: string },
): Promise<Result<QuoteView, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  const access = await authorizeVehicleAccess(db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;

  // Reintento de la misma solicitud: devolver la cotización ya emitida sin volver a llamar al taller.
  const previous = await db.journeyEvent.findUnique({ where: { idempotencyKey: `quote:${cmd.idempotencyKey}` }, include: { journey: true } });
  if (previous) {
    const quote = await db.quote.findUnique({ where: { id: (previous.payload as { quoteId: string }).quoteId } });
    if (!quote || quote.vehicleId !== cmd.vehicleId) return err(appError("IDEMPOTENCY_MISMATCH"));
    return ok({ ...toView(quote, previous.journey.state as JourneyState), duplicate: true });
  }

  const key = { vehicleId: cmd.vehicleId, serviceCode: cmd.serviceCode };
  const pre = await precheckJourney(db, key, { type: "QUOTE_ISSUED", quoteId: "precheck" }, journeyActor(cmd.actor));
  if (!pre.ok) return pre;

  const mapping = await externalServiceCode(db, cmd.workshopId, cmd.serviceCode);
  if (!mapping) return err(appError("INVALID_INPUT", "SERVICE_NOT_OFFERED_BY_WORKSHOP"));
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: cmd.vehicleId }, include: { spec: true } });

  const result = await workshop.getQuote({ ...mapping, specKey: specKeyOf(vehicle.spec) });

  if (!result.ok && result.error.code === "QUOTE_UNAVAILABLE") {
    const opened = await runInTransaction<{ quoteId: string; caseId: string }, AppError>(db, async (tx) => {
      const quote = await tx.quote.create({
        data: { vehicleId: cmd.vehicleId, workshopId: cmd.workshopId, serviceCode: cmd.serviceCode, status: "UNAVAILABLE", isEstimate: false, restrictions: [], source: result.source, traceId: cmd.traceId, createdAt: now },
      });
      const kase = await openHumanCaseInTx(tx, {
        actor: journeyActor(cmd.actor),
        vehicleId: cmd.vehicleId,
        serviceCode: cmd.serviceCode,
        reason: "QUOTE_UNAVAILABLE",
        priority: "NORMAL",
        summary: `Cotización no disponible en el catálogo del taller (${result.source})`,
        traceId: cmd.traceId,
        idempotencyKey: `quote-unavailable:${cmd.idempotencyKey}`,
        transitionJourney: true,
        now,
      });
      return kase.ok ? ok({ quoteId: quote.id, caseId: kase.value.caseId }) : kase;
    });
    if (!opened.ok) return opened;
    return err(appError("QUOTE_UNAVAILABLE", undefined, { refs: { quoteId: opened.value.quoteId, caseId: opened.value.caseId } }));
  }
  if (!result.ok) return err(workshopErrorToApp(result.error));

  const q = result.data;
  return runInTransaction<QuoteView, AppError>(db, async (tx) => {
    const quote = await tx.quote.create({
      data: {
        vehicleId: cmd.vehicleId,
        workshopId: cmd.workshopId,
        serviceCode: cmd.serviceCode,
        externalQuoteRef: q.externalQuoteRef,
        status: "ACTIVE",
        isEstimate: q.isEstimate,
        subtotalCop: q.subtotalCop,
        taxCop: q.taxCop,
        totalCop: q.totalCop,
        taxLabel: q.taxLabel,
        includedItems: q.includedItems as unknown as Prisma.InputJsonValue,
        restrictions: q.restrictions,
        catalogVersion: q.catalogVersion,
        validUntil: q.validUntil,
        source: result.source,
        traceId: cmd.traceId,
        createdAt: now,
      },
    });
    const applied = await applyJourneyEventInTx(tx, {
      ...key,
      event: { type: "QUOTE_ISSUED", quoteId: quote.id },
      actor: journeyActor(cmd.actor),
      traceId: cmd.traceId,
      idempotencyKey: `quote:${cmd.idempotencyKey}`,
    });
    if (!applied.ok) return err(journeyErrorToApp(applied.error));
    await audit(tx, { actor: cmd.actor, action: "QUOTE_ISSUED", entityType: "Quote", entityId: quote.id, details: { totalCop: q.totalCop, source: result.source, catalogVersion: q.catalogVersion }, traceId: cmd.traceId, at: now });
    return ok({ ...toView(quote, applied.value.to), duplicate: false });
  });
}

function toView(
  q: { id: string; workshopId: string; serviceCode: string; isEstimate: boolean; subtotalCop: number | null; taxCop: number | null; totalCop: number | null; taxLabel: string | null; includedItems: unknown; restrictions: string[]; validUntil: Date | null; catalogVersion: string | null; source: string },
  journeyState: JourneyState,
): Omit<QuoteView, "duplicate"> {
  return {
    quoteId: q.id,
    workshopId: q.workshopId,
    serviceCode: q.serviceCode,
    isEstimate: q.isEstimate,
    subtotalCop: q.subtotalCop ?? 0,
    taxCop: q.taxCop ?? 0,
    totalCop: q.totalCop ?? 0,
    taxLabel: q.taxLabel ?? "",
    includedItems: (q.includedItems as QuoteView["includedItems"]) ?? [],
    restrictions: q.restrictions,
    validUntil: q.validUntil ?? new Date(0),
    catalogVersion: q.catalogVersion ?? "",
    source: q.source as IntegrationSource,
    journeyState,
  };
}

// ───────────────────────────── getAvailableSlots ─────────────────────────────

export interface SlotView {
  slotRef: string;
  startsAt: Date;
  endsAt: Date;
}

/** Cupos vigentes del taller (MOCK). Sin cupos → NO_SLOTS sin mover el journey; con cupos → SLOT_SELECTION. */
export async function getAvailableSlots(
  deps: BookingDeps,
  cmd: { actor: ActorContext; vehicleId: string; serviceCode: string; workshopId: string; days?: number; traceId: string; idempotencyKey: string },
): Promise<Result<{ slots: SlotView[]; source: IntegrationSource; journeyState: JourneyState }, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  const access = await authorizeVehicleAccess(db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;
  const key = { vehicleId: cmd.vehicleId, serviceCode: cmd.serviceCode };
  const pre = await precheckJourney(db, key, { type: "SLOTS_LISTED", workshopId: cmd.workshopId }, journeyActor(cmd.actor));
  if (!pre.ok) return pre;

  const mapping = await externalServiceCode(db, cmd.workshopId, cmd.serviceCode);
  if (!mapping) return err(appError("INVALID_INPUT", "SERVICE_NOT_OFFERED_BY_WORKSHOP"));
  const days = Math.min(Math.max(cmd.days ?? 7, 1), 14);
  const result = await workshop.listSlots({ ...mapping, from: now, to: new Date(now.getTime() + days * 86_400_000) });
  if (!result.ok) return err(workshopErrorToApp(result.error));
  const slots = result.data.filter((s) => s.startsAt.getTime() > now.getTime() && s.remaining > 0);
  if (slots.length === 0) return err(appError("NO_SLOTS"));

  return runInTransaction(db, async (tx) => {
    const applied = await applyJourneyEventInTx(tx, {
      ...key,
      event: { type: "SLOTS_LISTED", workshopId: cmd.workshopId },
      actor: journeyActor(cmd.actor),
      traceId: cmd.traceId,
      idempotencyKey: `slots:${cmd.idempotencyKey}`,
    });
    if (!applied.ok) return err(journeyErrorToApp(applied.error));
    return ok({ slots: slots.map(({ slotRef, startsAt, endsAt }) => ({ slotRef, startsAt, endsAt })), source: result.source, journeyState: applied.value.to });
  });
}
