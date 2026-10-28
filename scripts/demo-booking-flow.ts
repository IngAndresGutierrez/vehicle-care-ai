/**
 * Evidencia del flujo de reserva de la Fase 4 sobre sistemas MOCK:
 * evaluación → apertura → recomendación → talleres → cotización → horarios → intención → confirmación → reserva.
 *
 * Usa una base desechable (vehicle_care_flow_<timestamp>): no toca vehicle_care ni vehicle_care_test.
 * Escribe prd/reports/evidence/booking-flow.json. El token de confirmación se redacta.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { confirmBooking } from "../src/application/booking/confirm-booking";
import { prepareBooking } from "../src/application/booking/prepare-booking";
import { getAvailableSlots, listWorkshops, requestQuote } from "../src/application/booking/quotes-and-slots";
import { applyJourneyEvent, findJourney, verifyJourneyConsistency } from "../src/application/journey/journey-store";
import { runEvaluationJob } from "../src/application/run-evaluation-job";
import { DEMO_NOW } from "../src/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { fixedClock } from "../src/infra/clock";
import { createPrismaClient } from "../src/infra/prisma";
import { DEMO_IDS } from "../src/infra/seed/demo-seed";
import { MockCrmAdapter } from "../src/integrations/mock/mock-crm-adapter";
import { MockNotificationPort } from "../src/integrations/mock/mock-notifications";
import { MockWorkshopAdapter } from "../src/integrations/mock/mock-workshop-adapter";
import { MockWorkshopSystem } from "../src/integrations/mock/mock-workshop-system";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL no está definida");
const dbName = `vehicle_care_flow_${Date.now()}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const run = (args: string[]) =>
  execFileSync("pnpm", ["exec", ...args], { env: { ...process.env, DATABASE_URL: targetUrl.toString(), PRISMA_TARGET: "" }, stdio: "pipe" });

function unwrap<T>(step: string, r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${step} falló: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function main() {
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const evidence: Array<{ step: string; result: unknown }> = [];
  const log = (step: string, result: unknown) => {
    evidence.push({ step, result });
    console.log(`▶ ${step}\n${JSON.stringify(result, null, 2)}\n`);
  };

  try {
    run(["prisma", "migrate", "deploy"]);
    run(["tsx", "prisma/seed.ts"]);
    const db = createPrismaClient(targetUrl.toString());
    const clock = fixedClock(DEMO_NOW.toISOString());
    const deps = { db, clock, workshop: new MockWorkshopAdapter(new MockWorkshopSystem(db, clock)), crm: new MockCrmAdapter(db) };
    const { vehicles: V, customers: C, actors: A, workshops: W } = DEMO_IDS;
    const owner = { actorId: A.ownerC1, role: "OWNER" as const, customerId: C.c1, workshopId: null };
    const agent = { actorId: "agent", role: "SYSTEM_AGENT" as const, customerId: C.c1, workshopId: null };
    const key = { vehicleId: V.v1, serviceCode: "ENGINE_OIL_FILTER" };

    const job = await runEvaluationJob({ db, clock, notifications: new MockNotificationPort() }, { actor: { actorId: A.systemJob, role: "SYSTEM_JOB", customerId: null, workshopId: null }, traceId: "trc-demo-job" });
    log("0. Evaluación (job)", job.find((i) => i.vehicleId === V.v1 && i.serviceCode === key.serviceCode));
    unwrap("apertura", await applyJourneyEvent(db, { ...key, event: { type: "OWNER_OPENED" }, actor: owner, traceId: "trc-demo", idempotencyKey: "demo-open" }));
    const evaluationId = (await findJourney(db, key))!.context.lastEvaluation!.evaluationId;
    unwrap("recomendación", await applyJourneyEvent(db, { ...key, event: { type: "RECOMMENDATION_SHOWN", evaluationId }, actor: agent, traceId: "trc-demo", idempotencyKey: "demo-reco" }));
    log("1. Recomendación presentada", { journeyState: (await findJourney(db, key))!.state, evaluationId });

    log("2. Talleres", unwrap("talleres", await listWorkshops(deps, { actor: owner, ...key })));
    const quote = unwrap("cotización", await requestQuote(deps, { actor: agent, ...key, workshopId: W.t1, traceId: "trc-demo", idempotencyKey: "demo-quote" }));
    log("3. Cotización (MOCK)", quote);
    const slots = unwrap("horarios", await getAvailableSlots(deps, { actor: agent, ...key, workshopId: W.t1, traceId: "trc-demo", idempotencyKey: "demo-slots" }));
    log("4. Horarios (MOCK)", slots);
    const prepared = unwrap("intención", await prepareBooking(deps, { actor: agent, ...key, quoteId: quote.quoteId, slotRef: slots.slots[0].slotRef, traceId: "trc-demo", idempotencyKey: "demo-intent" }));
    log("5. Intención de reserva (requiere clic del propietario)", { ...prepared, confirmationToken: `[REDACTADO: ${prepared.confirmationToken.length} caracteres]` });
    log("5b. El agente intenta confirmar", await confirmBooking(deps, { actor: agent, confirmationToken: prepared.confirmationToken, traceId: "trc-demo" }));
    const confirmed = unwrap("confirmación", await confirmBooking(deps, { actor: owner, confirmationToken: prepared.confirmationToken, traceId: "trc-demo" }));
    log("6. Confirmación por el propietario (folio del taller MOCK)", confirmed);

    const journey = (await findJourney(db, key))!;
    const events = await db.journeyEvent.findMany({ where: { journeyId: journey.id }, orderBy: { seq: "asc" } });
    log("7. Reserva y journey", {
      booking: await db.booking.findFirst({ where: { vehicleId: V.v1 }, select: { status: true, externalBookingRef: true, source: true, confirmedByRole: true, startsAt: true } }),
      mockWorkshopBooking: await db.mockBooking.findFirst({ select: { folio: true, status: true, slotId: true } }),
      journeyState: journey.state,
      journeyEvents: events.map((e) => `${e.seq}. ${e.type} ${e.fromState}→${e.toState} (${e.actorRole})`),
      consistency: await verifyJourneyConsistency(db, journey.id),
    });
    await db.$disconnect();

    mkdirSync("prd/reports/evidence", { recursive: true });
    writeFileSync(
      "prd/reports/evidence/booking-flow.json",
      JSON.stringify({ generatedWith: "pnpm demo:booking-flow", note: "Datos y sistemas SIMULADOS (MOCK/SYNTHETIC-DEMO). Token redactado.", clock: DEMO_NOW.toISOString(), evidence }, null, 2) + "\n",
    );
    console.log("✔ Evidencia escrita en prd/reports/evidence/booking-flow.json");
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
