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
