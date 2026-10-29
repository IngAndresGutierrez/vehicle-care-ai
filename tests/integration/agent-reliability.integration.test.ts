import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MaintenanceAdvisor } from "@/agent/maintenance-advisor";
import { ScriptedLlm } from "@/agent/llm/scripted-llm";
import type { LlmMessage, LlmPort, LlmRequest, LlmResponse } from "@/agent/llm/types";
import { findJourney } from "@/application/journey/journey-store";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { HASH_SECRET, runJob, say } from "./helpers/agent";
import { depsAt, OIL, OWNER_C1 } from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V } = DEMO_IDS;
const advisorWith = (llm: LlmPort, limits: Record<string, number> = {}) => new MaintenanceAdvisor({ ...depsAt(db), llm, hashSecret: HASH_SECRET, limits });
let seq = 0;
const turn = (llm: LlmPort, message: string, sessionId?: string, limits?: Record<string, number>) =>
  advisorWith(llm, limits).handleTurn({ owner: OWNER_C1, vehicleId: V.v1, message, sessionId, traceId: `trc-rel-${++seq}` });

/** Todo tool_use de la transcripción debe tener su tool_result: si no, la API rechazaría el siguiente turno. */
function assertValidTranscript(transcript: LlmMessage[]) {
  for (const [i, m] of transcript.entries()) {
    const uses = m.role === "assistant" ? m.content.filter((b) => b.type === "tool_use") : [];
    if (uses.length === 0) continue;
    const next = transcript[i + 1];
    const answered = new Set((next?.content ?? []).flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : [])));
    for (const u of uses) if (u.type === "tool_use") expect(answered.has(u.id), `tool_use ${u.id} sin tool_result`).toBe(true);
  }
}
const transcriptOf = async (sessionId: string) => ((await db.conversationSession.findUniqueOrThrow({ where: { id: sessionId } })).transcript as unknown as LlmMessage[]) ?? [];

/** Modelo lento: responde con herramientas según ScriptedLlm, pero en la llamada N espera hasta que lo aborten. */
class HangsOnCall implements LlmPort {
  readonly info = { provider: "SCRIPTED" as const, model: "hangs (prueba)", simulated: true };
  private calls = 0;
  private readonly inner = new ScriptedLlm();
  constructor(private readonly hangOn: number) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (++this.calls === this.hangOn) {
      return new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return this.inner.complete(req);
  }
}

beforeEach(async () => {
  await resetAndSeed(db);
  await runJob(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Timeouts del LLM", () => {
  it("antes de herramientas: LLM_TIMEOUT, sin herramientas ni cambios de journey, y el fallo queda trazado", async () => {
    const r = await turn(new HangsOnCall(1), "¿Qué mantenimiento le toca a mi carro?", undefined, { turnTimeoutMs: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.errors.map((e) => e.code)).toContain("LLM_TIMEOUT");
    expect(r.value.trace.toolCalls).toEqual([]);
    const msg = await db.conversationMessage.findFirstOrThrow({ where: { sessionId: r.value.sessionId, role: { not: "USER" } }, orderBy: { createdAt: "desc" } });
    expect(msg.flagged).toContain("ERROR:LLM_TIMEOUT");
  });

  it("después de herramientas: conserva y persiste las tarjetas (sin token) y la transcripción sigue válida", async () => {
    const r = await turn(new HangsOnCall(2), "¿Qué mantenimiento le toca a mi carro?", undefined, { turnTimeoutMs: 300 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.errors.map((e) => e.code)).toContain("LLM_TIMEOUT");
    expect(r.value.trace.flags).toContain("LLM_FAILED_AFTER_TOOLS");
    expect(r.value.cards.map((c) => c.type)).toContain("EVALUATION");
    const msg = await db.conversationMessage.findFirstOrThrow({ where: { sessionId: r.value.sessionId, role: { not: "USER" } }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(msg.cards)).toContain("EVALUATION");
    expect(msg.flagged).toEqual(expect.arrayContaining(["LLM_FAILED_AFTER_TOOLS", "ERROR:LLM_TIMEOUT"]));
    assertValidTranscript(await transcriptOf(r.value.sessionId));
    const next = await turn(new ScriptedLlm(), "¿Cuánto cuesta?", r.value.sessionId);
    expect(next.ok && next.value.cards.some((c) => c.type === "QUOTE")).toBe(true);
  });
});

describe("Turnos simultáneos en la misma sesión", () => {
  it("solo uno se procesa; el otro recibe TURN_IN_PROGRESS sin ejecutar herramientas ni duplicar intenciones", async () => {
    let s = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    s = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: s.sessionId });
    s = await say(db, OWNER_C1, V.v1, "¿Qué horarios hay?", { sessionId: s.sessionId });
    const toolsBefore = await db.toolCall.count({ where: { sessionId: s.sessionId } });
    const [a, b] = await Promise.all([turn(new ScriptedLlm(), "Reserva el primer horario", s.sessionId), turn(new ScriptedLlm(), "Reserva el primer horario", s.sessionId)]);
    const codes = [a, b].map((x) => (x.ok ? "OK" : x.error.code)).sort();
    expect(codes).toEqual(["OK", "TURN_IN_PROGRESS"]);
    expect(await db.bookingIntent.count({ where: { vehicleId: V.v1, status: "AWAITING_USER" } })).toBe(1);
    expect(await db.toolCall.count({ where: { sessionId: s.sessionId } })).toBe(toolsBefore + 1); // un solo prepareBooking
    assertValidTranscript(await transcriptOf(s.sessionId));
  });
});

describe("Sesiones vencidas y respuestas parciales", () => {
  it("una sesión inactiva más allá del límite se renueva (nuevo sessionId) en vez de reanudar contexto viejo", async () => {
    const r1 = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    // Relativo al reloj de la app (fijo en DEMO_NOW en las pruebas), no al de la base.
    await db.$executeRaw`UPDATE "ConversationSession" SET "lastActiveAt" = ${new Date(DEMO_NOW.getTime() - 5 * 3_600_000)} WHERE id = ${r1.sessionId}`;
    const r2 = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: r1.sessionId });
    expect(r2.sessionId).not.toBe(r1.sessionId);
  });

  it("max_tokens con una llamada a herramienta truncada: no se ejecuta, se responde de forma segura y la transcripción queda válida", async () => {
    const truncated: LlmPort = {
      info: { provider: "SCRIPTED", model: "truncated (prueba)", simulated: true },
      complete: async () => ({ stopReason: "max_tokens", content: [{ type: "text", text: "Voy a cotizar" }, { type: "tool_use", id: "tu_trunc", name: "getQuote", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, servedBy: "truncated" }),
    };
    const r1 = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    const r = await turn(truncated, "¿Cuánto cuesta?", r1.sessionId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.errors.map((e) => e.code)).toContain("INCOMPLETE_RESPONSE");
    expect(r.value.trace.toolCalls).toEqual([]);
    expect(r.value.cards).toEqual([]);
    assertValidTranscript(await transcriptOf(r1.sessionId));
    const next = await turn(new ScriptedLlm(), "¿Cuánto cuesta?", r1.sessionId);
    expect(next.ok).toBe(true);
    expect((await findJourney(db, { vehicleId: V.v1, serviceCode: OIL }))?.state).toBe("QUOTE_PRESENTED");
  });
});
