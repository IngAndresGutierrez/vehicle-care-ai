import type { BookingDeps } from "@/application/booking/common";
import { applyJourneyEvent, findJourney } from "@/application/journey/journey-store";
import { runEvaluationJob } from "@/application/run-evaluation-job";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { ActorContext } from "@/domain/policies/access-policy";
import { fixedClock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { MockCrmAdapter } from "@/integrations/mock/mock-crm-adapter";
import { MockNotificationPort } from "@/integrations/mock/mock-notifications";
import { MockWorkshopAdapter } from "@/integrations/mock/mock-workshop-adapter";
import { MockWorkshopSystem } from "@/integrations/mock/mock-workshop-system";

const { customers: C, actors: A } = DEMO_IDS;
export const OIL = "ENGINE_OIL_FILTER";

export const actor = (actorId: string, role: ActorContext["role"], customerId: string | null = null, workshopId: string | null = null): ActorContext => ({
  actorId,
  role,
  customerId,
  workshopId,
});
export const OWNER_C1 = actor(A.ownerC1, "OWNER", C.c1);
export const OWNER_C2 = actor(A.ownerC2, "OWNER", C.c2);
export const OWNER_C3 = actor(A.ownerC3, "OWNER", C.c3);
export const AGENT_C1 = actor("agent", "SYSTEM_AGENT", C.c1);
export const AGENT_C2 = actor("agent", "SYSTEM_AGENT", C.c2);
export const ADVISOR = actor(A.advisor, "ADVISOR");
export const JOB = actor(A.systemJob, "SYSTEM_JOB");
export const WS_T1 = actor(A.workshopT1, "WORKSHOP_COORDINATOR", null, DEMO_IDS.workshops.t1);
export const WS_T2 = actor(A.workshopT2, "WORKSHOP_COORDINATOR", null, DEMO_IDS.workshops.t2);

/** Dependencias con sistemas MOCK y reloj fijo `minutes` después del reloj demo. */
export function depsAt(db: Db, minutes = 0): BookingDeps {
  const clock = fixedClock(new Date(DEMO_NOW.getTime() + minutes * 60_000).toISOString());
  return { db, clock, workshop: new MockWorkshopAdapter(new MockWorkshopSystem(db, clock)), crm: new MockCrmAdapter(db) };
}

/**
 * Lleva el journey del vehículo hasta RECOMMENDATION_PRESENTED por el camino real: job de evaluación,
 * apertura por el propietario y recomendación basada en la última evaluación.
 */
export async function driveToRecommendation(db: Db, vehicleId: string, owner: ActorContext, agent: ActorContext): Promise<void> {
  const deps = depsAt(db);
  await runEvaluationJob({ db, clock: deps.clock, notifications: new MockNotificationPort() }, { actor: JOB, traceId: `trc-job-${vehicleId}` });
  const key = { vehicleId, serviceCode: OIL };
  const opened = await applyJourneyEvent(db, { ...key, event: { type: "OWNER_OPENED" }, actor: { actorId: owner.actorId, role: owner.role }, traceId: "trc", idempotencyKey: `open-${vehicleId}` });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const journey = await findJourney(db, key);
  const reco = await applyJourneyEvent(db, {
    ...key,
    event: { type: "RECOMMENDATION_SHOWN", evaluationId: journey!.context.lastEvaluation!.evaluationId },
    actor: { actorId: agent.actorId, role: agent.role },
    traceId: "trc",
    idempotencyKey: `reco-${vehicleId}`,
  });
  if (!reco.ok) throw new Error(JSON.stringify(reco.error));
}

export function must<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) throw new Error(`se esperaba éxito: ${JSON.stringify(r.error)}`);
  return r.value;
}
