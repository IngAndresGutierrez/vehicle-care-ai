import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedLlm } from "@/agent/llm/scripted-llm";
import type { LlmPort, LlmRequest, LlmResponse } from "@/agent/llm/types";
import { findJourney } from "@/application/journey/journey-store";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { runJob, say } from "./helpers/agent";
import { OIL, OWNER_C1 } from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V } = DEMO_IDS;

/** ScriptedLlm que «se cae» (p. ej. 529 o timeout) en la llamada que sigue a ciertos resultados de herramienta. */
class FlakyAfterTool implements LlmPort {
  readonly info = { provider: "SCRIPTED" as const, model: "flaky (prueba)", simulated: true };
  private readonly inner = new ScriptedLlm();
  constructor(private readonly failAfterTool: string) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages.at(-1);
    const prev = req.messages.at(-2);
    const answered = last?.role === "user" && last.content.some((b) => b.type === "tool_result");
    const toolName = prev?.content.find((b) => b.type === "tool_use");
    if (answered && toolName?.type === "tool_use" && toolName.name === this.failAfterTool) throw new Error("529 overloaded (simulado)");
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

describe("Proveedor caído DESPUÉS de ejecutar herramientas", () => {
  it("entrega la tarjeta de reserva preparada (sin perderla), deja una sola intención y no confirma nada", async () => {
    let r = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    r = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: r.sessionId });
    r = await say(db, OWNER_C1, V.v1, "¿Qué horarios hay?", { sessionId: r.sessionId });
    const failed = await say(db, OWNER_C1, V.v1, "Reserva el primer horario", { sessionId: r.sessionId, llm: new FlakyAfterTool("prepareBooking") });

    expect(failed.trace.flags).toContain("LLM_FAILED_AFTER_TOOLS");
    expect(failed.errors.map((e) => e.code)).toContain("LLM_UNAVAILABLE");
    const intent = failed.cards.find((c) => c.type === "BOOKING_INTENT");
    expect(intent && intent.type === "BOOKING_INTENT" && intent.confirmationToken).toBeTruthy();
    expect(failed.assistant.text).not.toMatch(/\$|\d{3}\.\d{3}|reservad|confirmad/i);
    expect((await findJourney(db, { vehicleId: V.v1, serviceCode: OIL }))?.state).toBe("AWAITING_CONFIRMATION");
    expect(await db.bookingIntent.count({ where: { vehicleId: V.v1, status: "AWAITING_USER" } })).toBe(1);
    expect(await db.booking.count({ where: { vehicleId: V.v1 } })).toBe(0);

    // La conversación sigue siendo válida: el siguiente turno funciona con el proveedor recuperado.
    const next = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: failed.sessionId });
    expect(next.errors.map((e) => e.code)).not.toContain("LLM_UNAVAILABLE");
    expect(await db.booking.count({ where: { vehicleId: V.v1 } })).toBe(0);
  });

  it("si cae antes de ejecutar herramientas, responde de forma segura sin cambiar el journey", async () => {
    const before = (await findJourney(db, { vehicleId: V.v1, serviceCode: OIL }))?.state;
    const down: LlmPort = { info: { provider: "SCRIPTED", model: "caído (prueba)", simulated: true }, complete: async () => Promise.reject(new Error("timeout")) };
    const r = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?", { llm: down });
    expect(r.errors.map((e) => e.code)).toContain("LLM_UNAVAILABLE");
    expect(r.cards).toEqual([]);
    expect(r.trace.toolCalls).toEqual([]);
    expect(["NEED_DETECTED", "CONVERSATION_OPEN"]).toContain((await findJourney(db, { vehicleId: V.v1, serviceCode: OIL }))?.state ?? before);
  });
});

/** Modelo de prueba: cotiza en los dos talleres en el mismo turno y cita ambos totales (comportamiento observado en Claude). */
class QuotesBoth implements LlmPort {
  readonly info = { provider: "SCRIPTED" as const, model: "quotes-both (prueba)", simulated: true };
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages.at(-1);
    const results = last?.role === "user" ? last.content.filter((b) => b.type === "tool_result") : [];
    if (results.length === 0) {
      return { stopReason: "tool_use", content: [{ type: "tool_use", id: "q1", name: "getQuote", input: { workshopId: "ws-demo-t1" } }, { type: "tool_use", id: "q2", name: "getQuote", input: { workshopId: "ws-demo-t2" } }], usage: { inputTokens: 1, outputTokens: 1 }, servedBy: this.info.model };
    }
    const totals = results.map((b) => (b.type === "tool_result" ? (JSON.parse(b.content) as { totalCop?: number }).totalCop : undefined)).filter((n): n is number => typeof n === "number");
    const fmt = (n: number) => `$${n.toLocaleString("es-CO")}`;
    return { stopReason: "end_turn", content: [{ type: "text", text: `Taller Norte: ${fmt(totals[0])}. Taller Sur: ${fmt(totals[1])}.` }], usage: { inputTokens: 1, outputTokens: 1 }, servedBy: this.info.model };
  }
}

describe("Guardia de salida con varias herramientas en el mismo turno", () => {
  it("acepta cifras de dos cotizaciones devueltas en este turno (antes era un falso positivo) y sigue bloqueando cifras inventadas", async () => {
    const r1 = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    const r2 = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta en cada taller?", { sessionId: r1.sessionId, llm: new QuotesBoth() });
    expect(r2.trace.toolCalls.filter((t) => t.tool === "getQuote" && t.ok)).toHaveLength(2);
    expect(r2.trace.guard.blocked).toBe(false);
    expect(r2.assistant.text).toMatch(/Taller Norte: \$[\d.]+\. Taller Sur: \$[\d.]+\./);

    const liar: LlmPort = { info: { provider: "SCRIPTED", model: "liar (prueba)", simulated: true }, complete: async () => ({ stopReason: "end_turn", content: [{ type: "text", text: "Te sale en $99.000." }], usage: { inputTokens: 1, outputTokens: 1 }, servedBy: "liar" }) };
    const r3 = await say(db, OWNER_C1, V.v1, "¿Y más barato?", { sessionId: r2.sessionId, llm: liar });
    expect(r3.trace.guard.blocked).toBe(true);
    expect(r3.assistant.text).not.toContain("99.000");
  });
});

describe("Sesiones ante cambios de prompt o de modelo real", () => {
  it("si la sesión se creó con otra versión del prompt, abre una sesión nueva en vez de reenviar un historial incompatible", async () => {
    const r1 = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    await db.conversationSession.update({ where: { id: r1.sessionId }, data: { promptVersion: "advisor-v0" } });
    const r2 = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: r1.sessionId });
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect((await db.conversationSession.findUniqueOrThrow({ where: { id: r2.sessionId } })).promptVersion).not.toBe("advisor-v0");
  });

  it("si cambia el modelo real (p. ej. Sonnet → Opus), también abre una sesión nueva; con modelos simulados no", async () => {
    const real = (model: string): LlmPort => ({ info: { provider: "ANTHROPIC", model, simulated: false }, complete: (req) => new ScriptedLlm().complete(req) });
    const a = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?", { llm: real("claude-sonnet-5-5") });
    const b = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: a.sessionId, llm: real("claude-sonnet-5-5") });
    expect(b.sessionId).toBe(a.sessionId);
    const c = await say(db, OWNER_C1, V.v1, "¿Qué horarios hay?", { sessionId: b.sessionId, llm: real("claude-opus-5-5") });
    expect(c.sessionId).not.toBe(b.sessionId);
  });
});
