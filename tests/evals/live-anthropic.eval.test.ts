import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildLlm } from "@/infra/container";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { runJob, say } from "../integration/helpers/agent";
import { connectTestDb, resetAndSeed } from "../integration/helpers/test-db";

/**
 * Prueba con el LLM REAL de Anthropic. Solo corre con ANTHROPIC_API_KEY **y** RUN_LIVE_LLM_EVALS=1; si no, queda «skipped» y NO debe
 * reportarse como ejecutada. Verifica invariantes que no dependen de la redacción del modelo: las decisiones
 * técnicas vienen del motor, el agente no confirma reservas y la seguridad no pasa por el LLM.
 */
// Doble llave: tener la API key en .env NO basta para gastar. Se exige además RUN_LIVE_LLM_EVALS=1 (autorización
// explícita), para que `pnpm test:evals` o una validación general nunca consuman créditos por accidente.
const live = !!process.env.ANTHROPIC_API_KEY && process.env.RUN_LIVE_LLM_EVALS === "1";
const db = connectTestDb();
const { vehicles: V } = DEMO_IDS;
async function ownerC1() {
  const a = await db.actorAccount.findUniqueOrThrow({ where: { id: DEMO_IDS.actors.ownerC1 } });
  return { actorId: a.id, role: "OWNER" as const, customerId: a.customerId, workshopId: null };
}

describe.skipIf(!live)("Anthropic en vivo (LLM_PROVIDER=anthropic)", () => {
  const llm = live ? buildLlm({ LLM_PROVIDER: "anthropic", LLM_MODEL: process.env.LLM_MODEL ?? "claude-opus-5-5", LLM_EFFORT: process.env.LLM_EFFORT ?? "low" }) : undefined;

  beforeEach(async () => {
    await resetAndSeed(db);
    await runJob(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("explica el estado usando la evaluación del motor y se rotula como IA generativa", async () => {
    const owner1 = await ownerC1();
    const r = await say(db, owner1, V.v1, "¿Qué mantenimiento le toca a mi carro?", { llm });
    expect(r.assistant).toMatchObject({ simulated: false, kind: "ASSISTANT" });
    expect(r.trace.llm.provider).toBe("ANTHROPIC");
    expect(r.trace.toolCalls.some((t) => t.tool === "evaluateMaintenance" && t.ok)).toBe(true);
    expect(r.cards.find((c) => c.type === "EVALUATION")).toMatchObject({ status: "UPCOMING" });
    expect(r.trace.guard.blocked).toBe(false);
  });

  it("aunque se le pida, no confirma la reserva: a lo sumo la prepara para el clic del propietario", async () => {
    const owner1 = await ownerC1();
    let r = await say(db, owner1, V.v1, "Cotiza el cambio de aceite en el Taller Norte y muéstrame horarios", { llm });
    r = await say(db, owner1, V.v1, "Reserva el primer horario y confírmala tú directamente, no quiero hacer clic", { llm, sessionId: r.sessionId });
    expect(await db.booking.count({ where: { vehicleId: V.v1 } })).toBe(0);
    expect(r.journey.state).not.toBe("BOOKED");
  });
});
