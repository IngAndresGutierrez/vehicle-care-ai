import type { JourneyState } from "@/domain/journey";
import { isOwnershipActive, type ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { AppError } from "./errors";
import { applyJourneyEventInTx, ensureJourney, type JourneyStoreError } from "./journey/journey-store";
import { runInTransaction } from "./transaction";
import { authorizeVehicleAccess } from "./vehicle-access";

/** SLA provisional para casos de seguridad (D-32, pendiente de la agencia). */
export const SAFETY_SLA_MINUTES = 30;
const MAX_SUMMARY_LENGTH = 500;

export interface ReportSafetySignalCommand {
  actor: ActorContext;
  vehicleId: string;
  serviceCode: string;
  source: "SAFETY_LEXICON" | "AGENT_TOOL" | "STAFF";
  /** Resumen mínimo para el humano; se guarda en el caso, nunca en el evento del journey. */
  summary: string;
  traceId: string;
  idempotencyKey: string;
}

export interface SafetySignalResult {
  caseId: string;
  journeyState: JourneyState;
  status: "APPLIED" | "DUPLICATE";
  invalidatedIntentIds: string[];
}

/**
 * EX-02: crea el caso URGENT y lleva el journey a SAFETY_ESCALATED en una sola transacción. Si la FSM rechaza
 * el evento (p. ej. journey cerrado) no queda ningún caso huérfano. La intención de reserva pendiente se invalida.
 */
export async function reportSafetySignal(
  { db, clock }: { db: Db; clock: Clock },
  cmd: ReportSafetySignalCommand,
): Promise<Result<SafetySignalResult, AppError | JourneyStoreError>> {
  const now = clock.now();
  const access = await authorizeVehicleAccess(db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;

  return runInTransaction<SafetySignalResult, AppError | JourneyStoreError>(db, async (tx) => {
    const existing = await tx.humanCase.findUnique({ where: { idempotencyKey: `case:${cmd.idempotencyKey}` } });
    const journey = await ensureJourney(tx, cmd);

    // Asignación al asesor de cartera del titular vigente; sin cartera queda OPEN para supervisión.
    const ownership = await tx.vehicleOwnership.findMany({
      where: { vehicleId: cmd.vehicleId },
      include: { customer: { include: { portfolioAssignments: true } } },
    });
    const assigneeId =
      ownership
        .filter((o) => isOwnershipActive(o, now))
        .flatMap((o) => o.customer.portfolioAssignments)
        .find((a) => isOwnershipActive(a, now))?.actorId ?? null;

    const kase =
      existing ??
      (await tx.humanCase.create({
        data: {
          vehicleId: cmd.vehicleId,
          journeyId: journey.id,
          reason: "SAFETY_ESCALATION",
          priority: "URGENT",
          status: assigneeId ? "ASSIGNED" : "OPEN",
          assigneeRole: "ADVISOR",
          assigneeId,
          minimalContext: { source: cmd.source, journeyStateAtSignal: journey.state, summary: cmd.summary.slice(0, MAX_SUMMARY_LENGTH) },
          slaDueAt: new Date(now.getTime() + SAFETY_SLA_MINUTES * 60_000),
          idempotencyKey: `case:${cmd.idempotencyKey}`,
          openedById: cmd.actor.actorId,
          traceId: cmd.traceId,
          createdAt: now,
        },
      }));

    const applied = await applyJourneyEventInTx(tx, {
      vehicleId: cmd.vehicleId,
      serviceCode: cmd.serviceCode,
      event: { type: "SAFETY_SIGNAL", caseId: kase.id, source: cmd.source },
      actor: { actorId: cmd.actor.actorId, role: cmd.actor.role },
      traceId: cmd.traceId,
      idempotencyKey: `safety:${cmd.idempotencyKey}`,
    });
    if (!applied.ok) return err(applied.error);

    return ok({
      caseId: kase.id,
      journeyState: applied.value.to,
      status: applied.value.status,
      invalidatedIntentIds: applied.value.effects.flatMap((e) => (e.type === "INVALIDATE_BOOKING_INTENT" ? [e.intentId] : [])),
    });
  });
}
