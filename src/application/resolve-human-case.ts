import type { CaseResolutionOutcome, JourneyState } from "@/domain/journey";
import { decideCaseResolution, type ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { appError, type AppError } from "./errors";
import { applyJourneyEventInTx, type JourneyStoreError } from "./journey/journey-store";
import { runInTransaction } from "./transaction";

const MAX_RESOLUTION_LENGTH = 1_000;

export interface ResolveHumanCaseCommand {
  actor: ActorContext;
  caseId: string;
  outcome: CaseResolutionOutcome;
  /** Texto del humano: se guarda en el caso, no en el evento del journey. */
  resolution: string;
  traceId: string;
  idempotencyKey: string;
}

export interface ResolveHumanCaseResult {
  caseId: string;
  journeyState: JourneyState;
  status: "APPLIED" | "DUPLICATE";
}

/**
 * Resolución humana de un caso (EX-01/EX-02). Solo ADVISOR/COMPLIANCE asignados al caso. Cierra el caso,
 * aplica CASE_RESOLVED_BY_HUMAN con la identidad del actor y deja constancia en AuditLog, todo en una transacción.
 */
export async function resolveHumanCase(
  { db, clock }: { db: Db; clock: Clock },
  cmd: ResolveHumanCaseCommand,
): Promise<Result<ResolveHumanCaseResult, AppError | JourneyStoreError>> {
  const now = clock.now();

  return runInTransaction<ResolveHumanCaseResult, AppError | JourneyStoreError>(db, async (tx) => {
    const kase = await tx.humanCase.findUnique({
      where: { id: cmd.caseId },
      include: { journey: { select: { vehicleId: true, serviceCode: true } } },
    });
    if (!kase || !kase.journey) return err(appError("UNAUTHORIZED", "CASE_NOT_FOUND"));

    // Reintento de una resolución ya aplicada: devolver el resultado sin reevaluar permisos sobre un caso cerrado.
    const previous = await tx.journeyEvent.findUnique({ where: { idempotencyKey: `resolve:${cmd.idempotencyKey}` } });
    if (!previous) {
      const decision = decideCaseResolution(cmd.actor, { status: kase.status, assigneeId: kase.assigneeId });
      if (!decision.allowed) return err(appError("UNAUTHORIZED", decision.detail));
    }

    const applied = await applyJourneyEventInTx(tx, {
      vehicleId: kase.journey.vehicleId,
      serviceCode: kase.journey.serviceCode,
      event: { type: "CASE_RESOLVED_BY_HUMAN", caseId: kase.id, outcome: cmd.outcome },
      actor: { actorId: cmd.actor.actorId, role: cmd.actor.role },
      traceId: cmd.traceId,
      idempotencyKey: `resolve:${cmd.idempotencyKey}`,
    });
    if (!applied.ok) return err(applied.error);

    if (applied.value.status === "APPLIED") {
      const closed = await tx.humanCase.updateMany({
        where: { id: kase.id, status: { in: ["OPEN", "ASSIGNED"] } },
        data: { status: "RESOLVED", resolvedAt: now, resolution: cmd.resolution.slice(0, MAX_RESOLUTION_LENGTH) },
      });
      if (closed.count !== 1) return err({ code: "VERSION_CONFLICT", expected: 0, actual: -1, retryable: true });
      await tx.auditLog.create({
        data: {
          actorId: cmd.actor.actorId,
          actorRole: cmd.actor.role,
          action: "CASE_RESOLVED",
          entityType: "HumanCase",
          entityId: kase.id,
          details: { outcome: cmd.outcome, journeyEventSeq: applied.value.seq, journeyState: applied.value.to },
          traceId: cmd.traceId,
          occurredAt: now,
        },
      });
    }
    return ok({ caseId: kase.id, journeyState: applied.value.to, status: applied.value.status });
  });
}
