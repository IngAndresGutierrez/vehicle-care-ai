import { EMPTY_CONTEXT, INITIAL_STATE, transition, type JourneyActor, type JourneyEvent, type JourneySnapshot } from "@/domain/journey";
import { isOwnershipActive, type ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Prisma } from "@/generated/prisma/client";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { CrmPort } from "@/integrations/ports/crm";
import type { WorkshopError, WorkshopPort } from "@/integrations/ports/workshop";
import { appError, type AppError } from "../errors";
import { findJourney, type JourneyKey, type JourneyStoreError } from "../journey/journey-store";
import type { Tx } from "../transaction";

export interface BookingDeps {
  db: Db;
  clock: Clock;
  workshop: WorkshopPort;
  crm: CrmPort;
}

/**
 * Actor de sistema del servicio de reservas: registra hechos que no son decisiones de nadie (caducidad de una
 * intención, resultado de una reconciliación). Nunca confirma reservas: la FSM y la BD lo impiden.
 */
export const BOOKING_SERVICE_ACTOR: JourneyActor = { actorId: "system:booking-service", role: "SYSTEM_JOB" };

/** Vigencia máxima de una intención de reserva (D-23). */
export const INTENT_TTL_MINUTES = 10;

export const journeyActor = (a: ActorContext): JourneyActor => ({ actorId: a.actorId, role: a.role });

export function workshopErrorToApp(e: WorkshopError): AppError {
  switch (e.code) {
    case "SLOT_CONFLICT":
    case "NO_SLOTS":
    case "QUOTE_EXPIRED":
    case "QUOTE_UNAVAILABLE":
    case "WORKSHOP_UNAVAILABLE":
    case "IDEMPOTENCY_MISMATCH":
      return appError(e.code, e.raw, { retryable: e.retryable });
    case "NOT_FOUND":
      return appError("NOT_FOUND", e.raw);
    case "INVALID_STATE":
      return appError("WORK_ORDER_STATE", e.raw);
    case "OUTCOME_UNCERTAIN":
      return appError("WORKSHOP_UNAVAILABLE", "OUTCOME_UNCERTAIN", { retryable: false });
  }
}

export function journeyErrorToApp(e: JourneyStoreError): AppError {
  if ("state" in e && e.state === "SAFETY_ESCALATED") return appError("SAFETY_ESCALATED");
  if (e.code === "GUARD_REJECTED" && e.reason === "ACTIVE_BOOKING_EXISTS") return appError("ACTIVE_BOOKING_EXISTS");
  if (e.code === "VERSION_CONFLICT") return appError("CONFLICT", "VERSION_CONFLICT", { retryable: true });
  if (e.code === "IDEMPOTENCY_MISMATCH") return appError("IDEMPOTENCY_MISMATCH");
  if (e.code === "ACTOR_NOT_PERMITTED") return appError("UNAUTHORIZED", "ACTOR_NOT_PERMITTED");
  return appError("JOURNEY_STATE_INVALID", e.code === "GUARD_REJECTED" ? `${e.code}:${e.reason}` : `${e.code}:${e.state}`);
}

/**
 * Comprueba con la FSM, sin escribir, que el evento sería aceptado. Evita llamar a sistemas externos
 * (taller) cuando el journey no lo permite, p. ej. en SAFETY_ESCALATED.
 */
export async function precheckJourney(
  db: Db | Tx,
  key: JourneyKey,
  event: JourneyEvent,
  actor: JourneyActor,
): Promise<Result<JourneySnapshot, AppError>> {
  const journey = await findJourney(db, key);
  const snapshot: JourneySnapshot = journey ? { state: journey.state, context: journey.context } : { state: INITIAL_STATE, context: EMPTY_CONTEXT };
  const outcome = transition(snapshot, event, actor);
  return outcome.ok ? ok(snapshot) : err(journeyErrorToApp(outcome.error));
}

/** Registro de auditoría de acciones humanas y de sistema. Nunca incluye tokens ni texto libre. */
export async function audit(
  tx: Tx | Db,
  entry: { actor: { actorId: string; role: ActorContext["role"] }; action: string; entityType: string; entityId: string; details: Record<string, unknown>; traceId: string; at: Date },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: entry.actor.actorId,
      actorRole: entry.actor.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      details: entry.details as Prisma.InputJsonValue,
      traceId: entry.traceId,
      occurredAt: entry.at,
    },
  });
}

/** Asesor de cartera del titular vigente, para asignar casos humanos (ADR-016). */
export async function portfolioAdvisorFor(tx: Tx | Db, vehicleId: string, now: Date): Promise<string | null> {
  const ownerships = await tx.vehicleOwnership.findMany({
    where: { vehicleId },
    include: { customer: { include: { portfolioAssignments: true } } },
  });
  return (
    ownerships
      .filter((o) => isOwnershipActive(o, now))
      .flatMap((o) => o.customer.portfolioAssignments)
      .find((a) => isOwnershipActive(a, now))?.actorId ?? null
  );
}

export async function activeOwnerId(tx: Tx | Db, vehicleId: string, now: Date): Promise<string | null> {
  const ownerships = await tx.vehicleOwnership.findMany({ where: { vehicleId } });
  return ownerships.find((o) => isOwnershipActive(o, now))?.customerId ?? null;
}

/** Clave de catálogo del taller: identifica la especificación técnica del vehículo. */
export function specKeyOf(spec: { make: string; model: string; modelYear: number; engineCode: string | null }): string {
  return [spec.make, spec.model, spec.modelYear, spec.engineCode ?? "UNKNOWN"].join("|");
}

/** Mapea el código de servicio interno al del taller (capa anticorrupción, ADR-014). */
export async function externalServiceCode(db: Db | Tx, workshopId: string, serviceCode: string): Promise<{ workshopRef: string; externalServiceCode: string } | null> {
  const mapping = await db.workshopService.findUnique({
    where: { workshopId_serviceCode: { workshopId, serviceCode } },
    include: { workshop: true },
  });
  if (!mapping || !mapping.workshop.isActive) return null;
  return { workshopRef: mapping.workshop.externalRef, externalServiceCode: mapping.externalServiceCode };
}
