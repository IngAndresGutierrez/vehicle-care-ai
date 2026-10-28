import {
  EMPTY_CONTEXT,
  eventPayload,
  parseContext,
  replayJourney,
  transition,
  type ConsistencyIssue,
  type JourneyActor,
  type JourneyContext,
  type JourneyEffect,
  type JourneyError,
  type JourneyEvent,
  type JourneyState,
} from "@/domain/journey";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/infra/prisma";
import { runInTransaction, type Tx } from "../transaction";

export const USE_CASE = "UC-01";

export interface JourneyKey {
  vehicleId: string;
  serviceCode: string;
}

export interface JourneyRow {
  id: string;
  vehicleId: string;
  serviceCode: string;
  state: JourneyState;
  version: number;
  context: JourneyContext;
}

export interface ApplyEventCommand extends JourneyKey {
  event: JourneyEvent;
  actor: JourneyActor;
  traceId: string;
  /** Clave estable de la operación: un reintento con la misma clave devuelve el evento ya registrado. */
  idempotencyKey: string;
  /** Si se indica (acciones de usuario), la versión debe coincidir; sin ella el conflicto se reintenta. */
  expectedVersion?: number;
}

export interface ApplyEventResult {
  status: "APPLIED" | "DUPLICATE";
  journeyId: string;
  seq: number;
  from: JourneyState;
  to: JourneyState;
  version: number;
  effects: JourneyEffect[];
}

export type JourneyStoreError =
  | (JourneyError & { retryable?: false })
  | { code: "VERSION_CONFLICT"; expected: number; actual: number; retryable: boolean }
  | { code: "IDEMPOTENCY_MISMATCH"; idempotencyKey: string; retryable?: false };

const toRow = (r: { id: string; vehicleId: string; serviceCode: string; state: string; version: number; context: unknown }): JourneyRow => ({
  id: r.id,
  vehicleId: r.vehicleId,
  serviceCode: r.serviceCode,
  state: r.state as JourneyState,
  version: r.version,
  context: parseContext(r.context),
});

/** Crea el journey si no existe (ON CONFLICT DO NOTHING) y lo devuelve; seguro ante creaciones concurrentes. */
export async function ensureJourney(tx: Tx, key: JourneyKey): Promise<JourneyRow> {
  await tx.journeyInstance.createMany({
    data: [{ vehicleId: key.vehicleId, serviceCode: key.serviceCode, useCase: USE_CASE, state: "ACTIVATED", version: 0, context: EMPTY_CONTEXT as unknown as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  const row = await tx.journeyInstance.findUniqueOrThrow({
    where: { vehicleId_useCase_serviceCode: { vehicleId: key.vehicleId, useCase: USE_CASE, serviceCode: key.serviceCode } },
  });
  return toRow(row);
}

export async function findJourney(db: Db | Tx, key: JourneyKey): Promise<JourneyRow | null> {
  const row = await db.journeyInstance.findUnique({
    where: { vehicleId_useCase_serviceCode: { vehicleId: key.vehicleId, useCase: USE_CASE, serviceCode: key.serviceCode } },
  });
  return row ? toRow(row) : null;
}

/**
 * Aplica un evento de negocio dentro de una transacción existente:
 * idempotencia → FSM pura → UPDATE condicionado por versión → JourneyEvent con seq = nueva versión → efectos.
 * Estado, versión, contexto, evento y efectos se confirman o revierten juntos.
 */
export async function applyJourneyEventInTx(tx: Tx, cmd: ApplyEventCommand): Promise<Result<ApplyEventResult, JourneyStoreError>> {
  const previous = await tx.journeyEvent.findUnique({
    where: { idempotencyKey: cmd.idempotencyKey },
    include: { journey: { select: { vehicleId: true, serviceCode: true, version: true } } },
  });
  if (previous) {
    const sameOperation =
      previous.type === cmd.event.type &&
      previous.journey.vehicleId === cmd.vehicleId &&
      previous.journey.serviceCode === cmd.serviceCode;
    if (!sameOperation) return err({ code: "IDEMPOTENCY_MISMATCH", idempotencyKey: cmd.idempotencyKey });
    return ok({
      status: "DUPLICATE",
      journeyId: previous.journeyId,
      seq: previous.seq,
      from: previous.fromState as JourneyState,
      to: previous.toState as JourneyState,
      version: previous.journey.version,
      effects: [],
    });
  }

  const journey = await ensureJourney(tx, cmd);
  if (cmd.expectedVersion !== undefined && cmd.expectedVersion !== journey.version) {
    return err({ code: "VERSION_CONFLICT", expected: cmd.expectedVersion, actual: journey.version, retryable: false });
  }

  const outcome = transition({ state: journey.state, context: journey.context }, cmd.event, cmd.actor);
  if (!outcome.ok) return err(outcome.error);
  const { to, context, effects } = outcome.value;
  const nextVersion = journey.version + 1;

  // Bloqueo optimista: si otra transacción avanzó la versión, no se actualiza ninguna fila.
  const updated = await tx.journeyInstance.updateMany({
    where: { id: journey.id, version: journey.version },
    data: { state: to, version: nextVersion, context: context as unknown as Prisma.InputJsonValue },
  });
  if (updated.count !== 1) {
    return err({ code: "VERSION_CONFLICT", expected: journey.version, actual: -1, retryable: cmd.expectedVersion === undefined });
  }

  await tx.journeyEvent.create({
    data: {
      journeyId: journey.id,
      seq: nextVersion,
      type: cmd.event.type,
      fromState: journey.state,
      toState: to,
      payload: eventPayload(cmd.event) as Prisma.InputJsonValue,
      actorId: cmd.actor.actorId,
      actorRole: cmd.actor.role,
      traceId: cmd.traceId,
      idempotencyKey: cmd.idempotencyKey,
    },
  });

  for (const effect of effects) {
    if (effect.type === "INVALIDATE_BOOKING_INTENT") {
      await tx.bookingIntent.updateMany({ where: { id: effect.intentId, status: "AWAITING_USER" }, data: { status: "REJECTED" } });
    }
  }

  return ok({ status: "APPLIED", journeyId: journey.id, seq: nextVersion, from: journey.state, to, version: nextVersion, effects });
}

/** Aplica un evento en su propia transacción, con reintento ante conflictos de concurrencia. */
export function applyJourneyEvent(db: Db, cmd: ApplyEventCommand): Promise<Result<ApplyEventResult, JourneyStoreError>> {
  return runInTransaction(db, (tx) => applyJourneyEventInTx(tx, cmd));
}

/** Reproduce los eventos persistidos con la FSM y los compara con el estado y la versión guardados. */
export async function verifyJourneyConsistency(db: Db, journeyId: string): Promise<Result<JourneyState, ConsistencyIssue[]>> {
  const journey = await db.journeyInstance.findUniqueOrThrow({
    where: { id: journeyId },
    include: { events: { orderBy: { seq: "asc" } } },
  });
  const replay = replayJourney(
    journey.events.map((e) => ({
      seq: e.seq,
      event: { type: e.type, ...(e.payload as Record<string, unknown>) } as JourneyEvent,
      actorId: e.actorId,
      actorRole: e.actorRole,
      fromState: e.fromState as JourneyState,
      toState: e.toState as JourneyState,
    })),
    { state: journey.state as JourneyState, version: journey.version },
  );
  return replay.ok ? ok(replay.value.state) : replay;
}
