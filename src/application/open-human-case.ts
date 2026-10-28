import type { HumanCaseReason, JourneyState } from "@/domain/journey";
import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { CrmPort } from "@/integrations/ports/crm";
import { activeOwnerId, audit, journeyErrorToApp, portfolioAdvisorFor } from "./booking/common";
import { appError, type AppError } from "./errors";
import { applyJourneyEventInTx, ensureJourney } from "./journey/journey-store";
import { runInTransaction, type Tx } from "./transaction";
import { authorizeVehicleAccess } from "./vehicle-access";

/** SLA provisional por prioridad (D-32/D-35). URGENT solo se usa en seguridad (report-safety-signal). */
export const CASE_SLA_MINUTES = { LOW: 24 * 60, NORMAL: 8 * 60, HIGH: 2 * 60 } as const;
const MAX_SUMMARY_LENGTH = 500;

export type NonSafetyReason = Exclude<HumanCaseReason, "SAFETY_ESCALATION">;

export interface OpenCaseInput {
  actor: { actorId: string; role: ActorContext["role"] };
  vehicleId: string;
  serviceCode: string;
  reason: NonSafetyReason;
  priority: keyof typeof CASE_SLA_MINUTES;
  /** Resumen mínimo; se guarda en el caso, nunca en el evento del journey. */
  summary: string;
  traceId: string;
  idempotencyKey: string;
  /** false: registra el caso sin mover el journey (p. ej. reserva en reconciliación). */
  transitionJourney: boolean;
  now: Date;
}

export interface OpenCaseResult {
  caseId: string;
  assigneeId: string | null;
  slaDueAt: Date;
  journeyState: JourneyState;
  duplicate: boolean;
}

/**
 * Abre un caso humano dentro de una transacción existente (sin control de acceso: lo usan flujos ya autorizados
 * o de sistema). Asigna al asesor de cartera del titular vigente y, si corresponde, aplica HUMAN_CASE_OPENED.
 */
export async function openHumanCaseInTx(tx: Tx, input: OpenCaseInput): Promise<Result<OpenCaseResult, AppError>> {
  const key = `case:${input.idempotencyKey}`;
  const journey = await ensureJourney(tx, input);
  const existing = await tx.humanCase.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    return ok({ caseId: existing.id, assigneeId: existing.assigneeId, slaDueAt: existing.slaDueAt, journeyState: journey.state, duplicate: true });
  }

  const assigneeId = await portfolioAdvisorFor(tx, input.vehicleId, input.now);
  const slaDueAt = new Date(input.now.getTime() + CASE_SLA_MINUTES[input.priority] * 60_000);
  const kase = await tx.humanCase.create({
    data: {
      vehicleId: input.vehicleId,
      journeyId: journey.id,
      reason: input.reason,
      priority: input.priority,
      status: assigneeId ? "ASSIGNED" : "OPEN",
      assigneeRole: "ADVISOR",
      assigneeId,
      minimalContext: { journeyStateAtOpen: journey.state, summary: input.summary.slice(0, MAX_SUMMARY_LENGTH) },
      slaDueAt,
      idempotencyKey: key,
      openedById: input.actor.actorId,
      traceId: input.traceId,
      createdAt: input.now,
    },
  });

  let journeyState = journey.state;
  if (input.transitionJourney) {
    const applied = await applyJourneyEventInTx(tx, {
      vehicleId: input.vehicleId,
      serviceCode: input.serviceCode,
      event: { type: "HUMAN_CASE_OPENED", caseId: kase.id, reason: input.reason },
      actor: input.actor,
      traceId: input.traceId,
      idempotencyKey: `case-opened:${input.idempotencyKey}`,
    });
    if (!applied.ok) return err(journeyErrorToApp(applied.error));
    journeyState = applied.value.to;
  }

  await audit(tx, {
    actor: input.actor,
    action: "HUMAN_CASE_OPENED",
    entityType: "HumanCase",
    entityId: kase.id,
    details: { reason: input.reason, priority: input.priority, assigneeId, journeyTransition: input.transitionJourney },
    traceId: input.traceId,
    at: input.now,
  });
  return ok({ caseId: kase.id, assigneeId, slaDueAt, journeyState, duplicate: false });
}

/**
 * Caso de uso público (`createHumanCase`). Los casos de seguridad usan `reportSafetySignal`.
 * El registro en el CRM es posterior al commit y no bloquea la operación.
 */
export async function openHumanCase(
  deps: { db: Db; clock: Clock; crm?: CrmPort },
  cmd: {
    actor: ActorContext;
    vehicleId: string;
    serviceCode: string;
    reason: HumanCaseReason;
    priority: OpenCaseInput["priority"];
    summary: string;
    traceId: string;
    idempotencyKey: string;
  },
): Promise<Result<OpenCaseResult, AppError>> {
  if (cmd.reason === "SAFETY_ESCALATION") return err(appError("INVALID_INPUT", "USE_SAFETY_SIGNAL"));
  const now = deps.clock.now();
  const access = await authorizeVehicleAccess(deps.db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;

  const result = await runInTransaction<OpenCaseResult, AppError>(deps.db, (tx) =>
    openHumanCaseInTx(tx, { ...cmd, reason: cmd.reason as NonSafetyReason, actor: { actorId: cmd.actor.actorId, role: cmd.actor.role }, now, transitionJourney: true }),
  );
  if (result.ok && !result.value.duplicate && deps.crm) {
    const customerRef = await activeOwnerId(deps.db, cmd.vehicleId, now);
    if (customerRef) {
      await deps.crm.recordInteraction(
        { kind: "HUMAN_CASE_OPENED", customerRef, vehicleRef: cmd.vehicleId, payload: { caseId: result.value.caseId, reason: cmd.reason } },
        `crm:case:${result.value.caseId}`,
      );
    }
  }
  return result;
}
