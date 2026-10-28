import { MaintenanceAdvisor, type TurnResult } from "@/agent/maintenance-advisor";
import { ScriptedLlm } from "@/agent/llm/scripted-llm";
import type { LlmPort } from "@/agent/llm/types";
import { runEvaluationJob } from "@/application/run-evaluation-job";
import type { ActorContext } from "@/domain/policies/access-policy";
import type { Db } from "@/infra/prisma";
import { MockNotificationPort } from "@/integrations/mock/mock-notifications";
import { depsAt, JOB } from "./booking-flow";

export const HASH_SECRET = "test-hash-secret-0123456789-abcdefghij";

export function advisorAt(db: Db, minutes = 0, llm: LlmPort = new ScriptedLlm()) {
  const deps = depsAt(db, minutes);
  return { advisor: new MaintenanceAdvisor({ ...deps, llm, hashSecret: HASH_SECRET }), deps };
}

export async function runJob(db: Db): Promise<void> {
  const deps = depsAt(db);
  await runEvaluationJob({ db, clock: deps.clock, notifications: new MockNotificationPort() }, { actor: JOB, traceId: "trc-job" });
}

let turnSeq = 0;

/** Ejecuta un turno y falla si la API devolvería un error HTTP. */
export async function say(
  db: Db,
  owner: ActorContext,
  vehicleId: string,
  message: string,
  opts: { sessionId?: string; serviceCode?: string; minutes?: number; llm?: LlmPort } = {},
): Promise<TurnResult> {
  const { advisor } = advisorAt(db, opts.minutes ?? 0, opts.llm);
  const r = await advisor.handleTurn({ owner, vehicleId, message, sessionId: opts.sessionId, serviceCode: opts.serviceCode, traceId: `trc-turn-${++turnSeq}` });
  if (!r.ok) throw new Error(`turno rechazado: ${JSON.stringify(r.error)}`);
  return r.value;
}

export const toolsCalled = (r: TurnResult) => r.trace.toolCalls.map((t) => `${t.tool}:${t.ok ? "ok" : t.errorCode}`);
