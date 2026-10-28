/**
 * Evidencia reproducible de la Fase 5: los cuatro recorridos del agente a través de la API real
 * (POST /api/agent/turn y POST /api/bookings/confirm) sobre una base desechable.
 *
 * ⚠️ El LLM es ScriptedLlm: SIMULACIÓN DETERMINISTA por reglas, NO IA generativa. Taller y CRM son MOCK.
 * Para usar un modelo real: LLM_PROVIDER=anthropic (requiere ANTHROPIC_API_KEY); los resultados variarán.
 *
 * Escribe prd/reports/evidence/agent-journeys.json (tokens de confirmación redactados).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { runEvaluationJob } from "../src/application/run-evaluation-job";
import { DEMO_NOW } from "../src/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { fixedClock } from "../src/infra/clock";
import { buildContainer } from "../src/infra/container";
import { handleAgentTurn, handleBookingConfirm } from "../src/infra/http/handlers";
import { createPrismaClient } from "../src/infra/prisma";
import { DEMO_IDS } from "../src/infra/seed/demo-seed";
import { SESSION_COOKIE, signSession } from "../src/infra/session";
import { activateScenario } from "../src/integrations/mock/mock-scenarios";
import { MockNotificationPort } from "../src/integrations/mock/mock-notifications";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL no está definida");
const dbName = `vehicle_care_agent_${Date.now()}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;
const SECRET = "demo-only-session-secret-0123456789abcdef";

const run = (args: string[]) =>
  execFileSync("pnpm", ["exec", ...args], { env: { ...process.env, DATABASE_URL: targetUrl.toString(), PRISMA_TARGET: "" }, stdio: "pipe" });

type Json = Record<string, unknown>;
const redact = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, val) => (k === "confirmationToken" ? `[REDACTADO ${String(val).length} caracteres]` : val)));

async function main() {
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const evidence: Json[] = [];
  try {
    run(["prisma", "migrate", "deploy"]);
    run(["tsx", "prisma/seed.ts"]);
    const db = createPrismaClient(targetUrl.toString());
    const clock = fixedClock(DEMO_NOW.toISOString());
    const c = buildContainer({ SESSION_SECRET: SECRET, LOG_HASH_SECRET: SECRET, LLM_PROVIDER: "scripted", AGENT_TURNS_PER_MINUTE: "100" }, { db, clock });
    const { vehicles: V, actors: A } = DEMO_IDS;
    await runEvaluationJob({ db, clock, notifications: new MockNotificationPort() }, { actor: { actorId: A.systemJob, role: "SYSTEM_JOB", customerId: null, workshopId: null }, traceId: "trc-demo-job" });

    const cookie = (actorId: string) => `${SESSION_COOKIE}=${signSession({ actorId, exp: Math.floor(DEMO_NOW.getTime() / 1000) + 3600 }, SECRET)}`;
    const request = (url: string, body: Json, actorId: string) =>
      new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie(actorId) }, body: JSON.stringify(body) });

    async function conversation(title: string, actorId: string, vehicleId: string, steps: Array<string | { confirm: true } | { scenario: "SLOT_CONFLICT_ON_NEXT_BOOKING" }>, serviceCode?: string) {
      console.log(`\n══════ ${title} ══════`);
      const record: Json = { title, actorId, vehicleId, serviceCode: serviceCode ?? "ENGINE_OIL_FILTER", turns: [] as Json[] };
      let sessionId: string | undefined;
      let token = "";
      for (const step of steps) {
        if (typeof step === "string") {
          const res = await handleAgentTurn(request("/api/agent/turn", { vehicleId, message: step, ...(serviceCode ? { serviceCode } : {}), ...(sessionId ? { sessionId } : {}) }, actorId), c);
          const body = (await res.json()) as Json & { sessionId: string; cards: Json[]; trace: { toolCalls: Json[] }; assistant: { text: string; kind: string }; journey: { state: string } };
          sessionId = body.sessionId;
          token = (body.cards?.find((x) => x.type === "BOOKING_INTENT")?.confirmationToken as string) ?? token;
          console.log(`👤 ${step}`);
          for (const t of body.trace?.toolCalls ?? []) console.log(`   🔧 ${t.tool} → ${t.ok ? "ok" : t.errorCode} (${t.source}) ${t.summary}`);
          const kind = (body.assistant as { kind?: string })?.kind === "SYSTEM_NOTICE" ? "Plantilla del servidor · sin LLM" : "ScriptedLlm · simulación determinista";
          console.log(`🤖 [${kind}] ${body.assistant?.text}`);
          console.log(`   📍 journey=${body.journey?.state}; tarjetas=${(body.cards ?? []).map((x) => x.type).join(",") || "—"}`);
          (record.turns as Json[]).push({ user: step, httpStatus: res.status, response: redact(body) });
        } else if ("confirm" in step) {
          const res = await handleBookingConfirm(request("/api/bookings/confirm", { confirmationToken: token }, actorId), c);
          const body = await res.json();
          console.log(`🖱️  Clic del propietario en «Confirmar reserva» (fuera del LLM) → HTTP ${res.status} ${JSON.stringify(body.booking ?? body.error)}`);
          (record.turns as Json[]).push({ ownerClick: "POST /api/bookings/confirm", httpStatus: res.status, response: body });
        } else {
          await activateScenario(db, step.scenario);
          console.log(`⚙️  Escenario MOCK activado: ${step.scenario}`);
          (record.turns as Json[]).push({ mockScenario: step.scenario });
        }
      }
      const journey = await db.journeyInstance.findFirst({ where: { vehicleId, serviceCode: serviceCode ?? "ENGINE_OIL_FILTER" }, include: { events: { orderBy: { seq: "asc" } } } });
      record.journeyEvents = journey?.events.map((e) => `${e.seq}. ${e.type} ${e.fromState}→${e.toState} (${e.actorRole})`);
      evidence.push(record);
    }

    await conversation("A) Camino exitoso", A.ownerC1, V.v1, ["¿Qué mantenimiento le toca a mi carro?", "¿Cuánto cuesta?", "¿Qué horarios hay?", "Reserva el primer horario", { confirm: true }]);
    await conversation("B) Historial insuficiente → UNKNOWN → caso humano", A.ownerC2, V.v2, ["¿Debo cambiar la correa de distribución?"], "TIMING_BELT");
    await conversation("C) Síntoma de seguridad → SAFETY_ESCALATED → bloqueo comercial", A.ownerC3, V.v3, ["El freno se hunde y casi no detiene el carro", "Entonces cotízame el mantenimiento"]);

    // D: estado limpio para V2 (aceite, DUE) con conflicto de cupo al confirmar.
    await conversation("D) Conflicto de cupo → recuperación sin duplicar reserva", A.ownerC2, V.v2, [
      "¿Qué mantenimiento le toca a mi carro?",
      "¿Cuánto cuesta?",
      "¿Qué horarios hay?",
      "Reserva el primer horario",
      { scenario: "SLOT_CONFLICT_ON_NEXT_BOOKING" },
      { confirm: true },
      "¿Qué otros horarios hay?",
      "Reserva el segundo horario",
      { confirm: true },
    ]);
    const bookings = await db.booking.findMany({ where: { vehicleId: V.v2 }, select: { status: true, failureCode: true, externalBookingRef: true } });
    console.log(`\nReservas de V2: ${JSON.stringify(bookings)}; reservas en el taller MOCK: ${await db.mockBooking.count({ where: { vehicleRef: V.v2 } })}`);
    evidence.push({ title: "D) Verificación de duplicados", bookingsV2: bookings, mockWorkshopBookingsV2: await db.mockBooking.count({ where: { vehicleRef: V.v2 } }) });
    await db.$disconnect();

    mkdirSync("prd/reports/evidence", { recursive: true });
    writeFileSync(
      "prd/reports/evidence/agent-journeys.json",
      JSON.stringify(
        {
          generatedWith: "pnpm demo:agent-journeys",
          llm: "ScriptedLlm — SIMULACIÓN DETERMINISTA por reglas; no es IA generativa",
          note: "Taller, CRM y datos del vehículo son simulados (MOCK/SYNTHETIC-DEMO). Tokens de confirmación redactados.",
          clock: DEMO_NOW.toISOString(),
          journeys: evidence,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("\n✔ Evidencia escrita en prd/reports/evidence/agent-journeys.json");
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
    console.log(`▶ Base desechable eliminada: ${dbName}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
