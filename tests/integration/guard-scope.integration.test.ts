import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { LlmPort } from "@/agent/llm/types";
import { recordOdometer } from "@/application/record-odometer";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { runJob, say } from "./helpers/agent";
import { depsAt, OWNER_C1, OWNER_C2 } from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V } = DEMO_IDS;
/** Modelo de prueba que responde exactamente el texto dado, sin herramientas. */
const speaks = (text: string): LlmPort => ({
  info: { provider: "SCRIPTED", model: "speaks (prueba)", simulated: true },
  complete: async () => ({ stopReason: "end_turn", content: [{ type: "text", text }], usage: { inputTokens: 1, outputTokens: 1 }, servedBy: "speaks" }),
});

beforeEach(async () => {
  await resetAndSeed(db);
  await runJob(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Hechos tipados de la guardia acotados (Fase 8C): datos correctos pero de otro servicio, vehículo o vigencia", () => {
  it("servicio: el intervalo de la correa no respalda una afirmación en la conversación del aceite (y el del aceite sí)", async () => {
    const base = await say(db, OWNER_C2, V.v2, "¿Qué mantenimiento le toca a mi carro?");
    const belt = await say(db, OWNER_C2, V.v2, "¿Cada cuánto se cambia?", { sessionId: base.sessionId, llm: speaks("Se cambia cada 100.000 km.") });
    expect(belt.trace.guard.blocked).toBe(true);
    const oil = await say(db, OWNER_C2, V.v2, "¿Cada cuánto se cambia?", { sessionId: base.sessionId, llm: speaks("Se cambia cada 5.000 km.") });
    expect(oil.trace.guard.blocked).toBe(false);
  });

  it("vehículo e identidad: un kilometraje real de OTRO vehículo no respalda nada; el del propio sí", async () => {
    await recordOdometer(depsAt(db), { actor: OWNER_C2, vehicleId: V.v2, valueKm: 99_123, traceId: "odo-v2", idempotencyKey: "odo-v2" });
    const v1 = await say(db, OWNER_C1, V.v1, "¿Cuánto marca?", { llm: speaks("Tu carro marca 99.123 km.") });
    expect(v1.trace.guard.blocked).toBe(true);
    const v2 = await say(db, OWNER_C2, V.v2, "¿Cuánto marca?", { llm: speaks("Tu carro marca 99.123 km.") });
    expect(v2.trace.guard.blocked).toBe(false);
  });

  it("vigencia: el precio de una cotización vencida ya no respalda el texto", async () => {
    let s = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    s = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: s.sessionId });
    const quote = await db.quote.findFirstOrThrow({ where: { vehicleId: V.v1 }, orderBy: { createdAt: "desc" } });
    const fresh = await say(db, OWNER_C1, V.v1, "¿Me repites el precio?", { sessionId: s.sessionId, llm: speaks(`Te sale en $${quote.totalCop!.toLocaleString("es-CO")}.`) });
    expect(fresh.trace.guard.blocked).toBe(false);
    const minutes = Math.ceil((quote.validUntil!.getTime() - DEMO_NOW.getTime()) / 60_000) + 5;
    const stale = await say(db, OWNER_C1, V.v1, "¿Me repites el precio?", { sessionId: fresh.sessionId, minutes, llm: speaks(`Te sale en $${quote.totalCop!.toLocaleString("es-CO")}.`) });
    expect(stale.trace.guard.blocked).toBe(true);
    expect(stale.trace.flags).toContain("GUARD:UNSUPPORTED_AMOUNT");
  });
});
