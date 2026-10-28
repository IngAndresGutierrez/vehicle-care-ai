import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyJourneyConsistency } from "@/application/journey/journey-store";
import { reportSafetySignal } from "@/application/report-safety-signal";
import { runEvaluationJob } from "@/application/run-evaluation-job";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { ActorContext } from "@/domain/policies/access-policy";
import { fixedClock } from "@/infra/clock";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { MockNotificationPort } from "@/integrations/mock/mock-notifications";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V, customers: C, actors: A } = DEMO_IDS;
const OIL = "ENGINE_OIL_FILTER";
const SYSTEM_JOB: ActorContext = { actorId: A.systemJob, role: "SYSTEM_JOB", customerId: null, workshopId: null };
const DAY = 86_400_000;
const at = (days: number) => fixedClock(new Date(DEMO_NOW.getTime() + days * DAY).toISOString());

let notifications: MockNotificationPort;
const runJob = (days = 0, traceId = `trc-job-${days}`) =>
  runEvaluationJob({ db, clock: at(days), notifications }, { actor: SYSTEM_JOB, traceId });

const messages = (vehicleId: string) => db.outboundMessage.findMany({ where: { vehicleId }, orderBy: { createdAt: "asc" } });
const journeyOf = (vehicleId: string, serviceCode = OIL) =>
  db.journeyInstance.findFirstOrThrow({ where: { vehicleId, serviceCode }, include: { events: { orderBy: { seq: "asc" } } } });

beforeEach(async () => {
  await resetAndSeed(db);
  notifications = new MockNotificationPort();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Deduplicación de recordatorios (P0 de Fase 2)", () => {
  it("re-ejecutar el job no duplica mensajes, notificaciones ni eventos; las evaluaciones sí quedan auditadas", async () => {
    await runJob(0, "trc-run-1");
    const second = await runJob(0, "trc-run-2");
    await runJob(0, "trc-run-3");

    expect(await db.outboundMessage.count()).toBe(2); // V1 enviado, V2 suprimido
    expect(notifications.sent).toHaveLength(1); // solo el mensaje nuevo con consentimiento llegó al puerto (MOCK)
    expect(await db.maintenanceEvaluation.count()).toBe(24); // 8 por ejecución: historial auditable

    const v1 = second.find((i) => i.vehicleId === V.v1 && i.serviceCode === OIL);
    // La separación mínima se evalúa antes que la clave: la re-ejecución ni siquiera intenta escribir.
    // La clave única es la red de seguridad para ejecuciones concurrentes (ver test de concurrencia).
    expect(v1?.reminder).toEqual({ outcome: "SKIPPED", reason: "MIN_INTERVAL" });
    expect(v1?.journey).toMatchObject({ state: "NEED_DETECTED", evaluatedEvent: "REDUNDANT" });

    const journey = await journeyOf(V.v1);
    expect(journey.events.map((e) => e.type)).toEqual(["EVALUATED", "CONTACT_SENT"]);
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
  });

  it("la clave de deduplicación es estable y no depende de inputHash", async () => {
    await runJob(0);
    await runJob(0);
    const evaluations = await db.maintenanceEvaluation.findMany({ where: { vehicleId: V.v1, serviceCode: OIL }, orderBy: { evaluatedAt: "asc" } });
    // Mismo instante y datos → mismo inputHash; la clave no lo usa en ningún caso.
    const [message] = await messages(V.v1);
    expect(message.dedupKey).toMatch(/^reminder:v1:veh-demo-v1:ENGINE_OIL_FILTER:rule-demo-oil:svc-demo-1:demo-comm-v1:\d{4}-\d{2}-\d{2}:SENT$/);
    for (const e of evaluations) expect(message.dedupKey).not.toContain(e.inputHash);
    expect(message.cycleKey).toBe("veh-demo-v1:ENGINE_OIL_FILTER:rule-demo-oil:svc-demo-1");
    expect(message.evaluationId).toBe(evaluations[0].id);
  });

  it("dos ejecuciones concurrentes del job producen un único mensaje y una única notificación", async () => {
    await Promise.all([runJob(0, "trc-a"), runJob(0, "trc-b"), runJob(0, "trc-c")]);
    expect(await db.outboundMessage.count()).toBe(2);
    expect(notifications.sent).toHaveLength(1);
    for (const vehicleId of [V.v1, V.v2]) {
      const journey = await journeyOf(vehicleId);
      expect(new Set(journey.events.map((e) => e.idempotencyKey)).size).toBe(journey.events.length);
      expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
    }
  });
});

describe("Frecuencia configurable por ciclo", () => {
  it("respeta separación mínima y tope por ciclo (14 días, máximo 2) y luego suprime por FREQUENCY_CAP", async () => {
    await runJob(0);
    await runJob(7); // misma ventana o separación < 14 días: nada nuevo
    expect((await messages(V.v1)).map((m) => m.status)).toEqual(["SIMULATED_SENT"]);

    await runJob(14);
    expect((await messages(V.v1)).map((m) => m.status)).toEqual(["SIMULATED_SENT", "SIMULATED_SENT"]);

    await runJob(28);
    const all = await messages(V.v1);
    expect(all.map((m) => [m.status, m.suppressionReason])).toEqual([
      ["SIMULATED_SENT", null],
      ["SIMULATED_SENT", null],
      ["SUPPRESSED", "FREQUENCY_CAP"],
    ]);
    expect(notifications.sent).toHaveLength(2);
    expect((await journeyOf(V.v1)).state).toBe("CONTACT_SUPPRESSED");
  });

  it("los límites vienen de la política activa (configurables)", async () => {
    await db.communicationPolicy.update({ where: { id: DEMO_IDS.communicationPolicy }, data: { maxRemindersPerCycle: 1 } });
    await runJob(0);
    await runJob(14);
    expect((await messages(V.v1)).map((m) => m.suppressionReason)).toEqual([null, "FREQUENCY_CAP"]);
  });
});

describe("Consentimiento obligatorio (EX-04)", () => {
  it("sin consentimiento: SUPPRESSED una vez por ventana, sin consentEventId y sin llamar al puerto", async () => {
    await runJob(0);
    await runJob(0);
    const v2 = await messages(V.v2);
    expect(v2).toHaveLength(1);
    expect(v2[0]).toMatchObject({ status: "SUPPRESSED", suppressionReason: "CONSENT_REQUIRED", consentEventId: null });
    expect(notifications.sent.every((n) => n.outboundMessageId !== v2[0].id)).toBe(true);
    expect((await journeyOf(V.v2)).state).toBe("CONTACT_SUPPRESSED");
  });

  it("si el cliente vuelve a otorgar el consentimiento, el siguiente job envía y el journey vuelve a NEED_DETECTED", async () => {
    await runJob(0);
    const consent = await db.consent.findUniqueOrThrow({
      where: { customerId_purpose_channel: { customerId: C.c2, purpose: "MAINTENANCE_REMINDERS", channel: "WHATSAPP" } },
    });
    await db.consentEvent.create({
      data: { id: "regrant", consentId: consent.id, action: "GRANTED", legalTextVersion: "demo-legal-v1", evidenceRef: "SYNTHETIC-DEMO:test#regrant", capturedVia: "PORTAL", capturedById: A.ownerC2, occurredAt: new Date("2026-10-28T10:00:00-05:00") },
    });
    await db.consent.update({ where: { id: consent.id }, data: { isGranted: true } });

    await runJob(0, "trc-after-regrant");
    const v2 = await messages(V.v2);
    expect(v2.map((m) => [m.status, m.consentEventId])).toEqual([
      ["SUPPRESSED", null],
      ["SIMULATED_SENT", "regrant"],
    ]);
    const journey = await journeyOf(V.v2);
    expect(journey.events.map((e) => e.toState)).toEqual(["NEED_DETECTED", "CONTACT_SUPPRESSED", "NEED_DETECTED"]);
  });
});

describe("El journey controla el contacto", () => {
  it("con el journey en SAFETY_ESCALATED el job no aplica eventos ni contacta", async () => {
    await runJob(0);
    const advisor: ActorContext = { actorId: A.advisor, role: "ADVISOR", customerId: null, workshopId: null };
    const safety = await reportSafetySignal(
      { db, clock: at(1) },
      { actor: advisor, vehicleId: V.v1, serviceCode: OIL, source: "STAFF", summary: "Cliente reporta pedal de freno esponjoso (sintético)", traceId: "trc-s", idempotencyKey: "safety-1" },
    );
    expect(safety).toMatchObject({ ok: true, value: { journeyState: "SAFETY_ESCALATED" } });

    const items = await runJob(14);
    const v1 = items.find((i) => i.vehicleId === V.v1 && i.serviceCode === OIL);
    expect(v1?.journey).toMatchObject({ state: "SAFETY_ESCALATED", evaluatedEvent: "NOT_JOB_MANAGED" });
    expect(v1?.reminder).toEqual({ outcome: "SKIPPED", reason: "JOURNEY_STATE" });
    expect(await messages(V.v1)).toHaveLength(1);
  });

  it("estado final de cada journey tras el job de la fecha demo", async () => {
    await runJob(0);
    const journeys = await db.journeyInstance.findMany({ orderBy: [{ vehicleId: "asc" }, { serviceCode: "asc" }] });
    expect(journeys.map((j) => [j.vehicleId, j.serviceCode, j.state])).toEqual([
      [V.v1, OIL, "NEED_DETECTED"],
      [V.v1, "TIMING_BELT", "MONITORING"],
      [V.v2, OIL, "CONTACT_SUPPRESSED"],
      [V.v2, "TIMING_BELT", "ACTIVATED"],
      [V.v3, OIL, "MONITORING"],
      [V.v3, "TIMING_BELT", "MONITORING"],
      [V.v4, OIL, "ACTIVATED"],
      [V.v4, "TIMING_BELT", "ACTIVATED"],
    ]);
    for (const j of journeys) expect((await verifyJourneyConsistency(db, j.id)).ok).toBe(true);
  });
});
