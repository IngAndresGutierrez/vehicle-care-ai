import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { confirmBooking } from "@/application/booking/confirm-booking";
import { prepareBooking } from "@/application/booking/prepare-booking";
import { getAvailableSlots, requestQuote } from "@/application/booking/quotes-and-slots";
import { findJourney, verifyJourneyConsistency } from "@/application/journey/journey-store";
import { openHumanCase } from "@/application/open-human-case";
import { recordOdometer } from "@/application/record-odometer";
import { completeWorkOrder, openWorkOrder } from "@/application/workshop/work-orders";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { activateScenario } from "@/integrations/mock/mock-scenarios";
import { ADVISOR, AGENT_C1, OIL, OWNER_C1, OWNER_C2, WS_T1, WS_T2, actor, depsAt, driveToRecommendation, must } from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V, workshops: W } = DEMO_IDS;
const KEY_V1 = { vehicleId: V.v1, serviceCode: OIL };

/** Reserva confirmada de V1 en T1 por el flujo real. */
async function bookV1() {
  const deps = depsAt(db);
  await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
  const quote = must(await requestQuote(deps, { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, workshopId: W.t1, traceId: "t", idempotencyKey: "q" }));
  const slots = must(await getAvailableSlots(deps, { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, workshopId: W.t1, traceId: "t", idempotencyKey: "s" }));
  const prepared = must(await prepareBooking(deps, { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, quoteId: quote.quoteId, slotRef: slots.slots[0].slotRef, traceId: "t", idempotencyKey: "p" }));
  const confirmed = must(await confirmBooking(deps, { actor: OWNER_C1, confirmationToken: prepared.confirmationToken, traceId: "t" }));
  if (confirmed.status !== "CONFIRMED") throw new Error("reserva no confirmada");
  return confirmed;
}

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("recordOdometer", () => {
  it("IT-15: una lectura menor que la última verificada → ODOMETER_ROLLBACK, sin registrar", async () => {
    const before = await db.odometerReading.count();
    const r = await recordOdometer(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, valueKm: 69_000, traceId: "t", idempotencyKey: "o-1" });
    expect(r).toEqual({ ok: false, error: { code: "ODOMETER_ROLLBACK", refs: { lastVerifiedKm: "70000" } } });
    expect(await db.odometerReading.count()).toBe(before);
  });

  it("lo declarado por el propietario queda UNVERIFIED y se rotula según el origen del vehículo; es idempotente", async () => {
    const r = must(await recordOdometer(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, valueKm: 74_300, traceId: "t", idempotencyKey: "o-2" }));
    expect(r).toMatchObject({ provenance: "OWNER_DECLARED", verification: "UNVERIFIED", duplicate: false });
    expect(await db.odometerReading.findUniqueOrThrow({ where: { id: r.readingId } })).toMatchObject({ dataOrigin: "SYNTHETIC", syntheticSourceRef: expect.stringMatching(/^SYNTHETIC-DEMO:/) });
    expect(must(await recordOdometer(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, valueKm: 74_300, traceId: "t", idempotencyKey: "o-2" }))).toMatchObject({ duplicate: true });
    expect(await recordOdometer(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, valueKm: 74_999, traceId: "t", idempotencyKey: "o-2" })).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_MISMATCH" } });
  });

  it("en conversación aplica ODOMETER_RECORDED; fuera de ella solo registra", async () => {
    await driveToRecommendation(db, V.v2, OWNER_C2, actor("agent", "SYSTEM_AGENT", DEMO_IDS.customers.c2));
    const outside = must(await recordOdometer(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, valueKm: 74_250, traceId: "t", idempotencyKey: "o-3" }));
    expect(outside.journeysUpdated).toEqual([]);
    // V2 está en RECOMMENDATION_PRESENTED (no es conversación abierta): tampoco se aplica.
    const v2 = must(await recordOdometer(depsAt(db), { actor: OWNER_C2, vehicleId: V.v2, valueKm: 95_100, traceId: "t", idempotencyKey: "o-4" }));
    expect(v2.journeysUpdated).toEqual([]);
  });

  it("valida entrada y acceso: valores inválidos, fecha futura, otro cliente y roles sin justificación", async () => {
    const deps = depsAt(db);
    expect(await recordOdometer(deps, { actor: OWNER_C1, vehicleId: V.v1, valueKm: -1, traceId: "t", idempotencyKey: "a" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await recordOdometer(deps, { actor: OWNER_C1, vehicleId: V.v1, valueKm: 74_300, observedAt: new Date("2030-01-01T00:00:00Z"), traceId: "t", idempotencyKey: "b" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", detail: "OBSERVED_AT" } });
    expect(await recordOdometer(deps, { actor: OWNER_C2, vehicleId: V.v1, valueKm: 74_300, traceId: "t", idempotencyKey: "c" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await recordOdometer(deps, { actor: actor("comp", "COMPLIANCE"), vehicleId: V.v1, valueKm: 74_300, traceId: "t", idempotencyKey: "d" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("lecturas concurrentes del mismo vehículo se serializan sin perder registros", async () => {
    const results = await Promise.all([74_300, 74_400, 74_500].map((km, i) => recordOdometer(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, valueKm: km, traceId: "t", idempotencyKey: `conc-${i}` })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db.odometerReading.count({ where: { vehicleId: V.v1, provenance: "OWNER_DECLARED" } })).toBe(4);
  });
});

describe("Órdenes de trabajo (operación exclusiva del taller)", () => {
  it("IT-16: el taller abre y cierra la OT → servicio y odómetro verificados, re-evaluación NOT_DUE, FOLLOW_UP", async () => {
    const booking = await bookV1();
    const deps = depsAt(db, 60);
    const opened = must(await openWorkOrder(deps, { actor: WS_T1, bookingId: booking.bookingId, traceId: "t" }));
    expect(opened).toMatchObject({ journeyState: "IN_SERVICE", workOrderRef: expect.stringMatching(/^OT-/) });

    const done = must(await completeWorkOrder(deps, { actor: WS_T1, workOrderId: opened.workOrderId, completionOdometerKm: 74_300, traceId: "t" }));
    expect(done).toMatchObject({ journeyState: "FOLLOW_UP", reevaluation: { status: "NOT_DUE" } });

    expect(await db.serviceRecord.findUniqueOrThrow({ where: { id: done.serviceRecordId } })).toMatchObject({
      provenance: "WORKSHOP_VERIFIED",
      odometerKm: 74_300,
      workOrderId: opened.workOrderId,
      dataOrigin: "SYNTHETIC",
      syntheticSourceRef: expect.stringMatching(/^SYNTHETIC-DEMO:mock-workshop\//),
    });
    expect(await db.odometerReading.findUniqueOrThrow({ where: { id: done.odometerReadingId } })).toMatchObject({ provenance: "WORKSHOP_VERIFIED", verification: "VERIFIED", valueKm: 74_300 });
    expect(await db.workOrder.findUniqueOrThrow({ where: { id: opened.workOrderId } })).toMatchObject({ status: "COMPLETED", completedById: WS_T1.actorId });
    expect(await db.mockWorkOrder.findFirstOrThrow()).toMatchObject({ status: "COMPLETED", completionOdometerKm: 74_300 });

    const evaluation = await db.maintenanceEvaluation.findUniqueOrThrow({ where: { id: done.reevaluation!.evaluationId } });
    expect(evaluation).toMatchObject({ baselineServiceRecordId: done.serviceRecordId, dueByKm: 79_300, status: "NOT_DUE" });
    const journey = (await findJourney(db, KEY_V1))!;
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
    const types = (await db.journeyEvent.findMany({ where: { journeyId: journey.id }, orderBy: { seq: "asc" } })).map((e) => e.type);
    expect(types.slice(-4)).toEqual(["BOOKING_CONFIRMED", "WORK_ORDER_OPENED", "WORK_ORDER_COMPLETED", "REEVALUATED"]);
    expect(await db.mockCrmInteraction.count({ where: { kind: "SERVICE_COMPLETED" } })).toBe(1);
  });

  it("propietario, agente, asesor y compliance no pueden abrir ni cerrar órdenes", async () => {
    const booking = await bookV1();
    const deps = depsAt(db, 60);
    const opened = must(await openWorkOrder(deps, { actor: WS_T1, bookingId: booking.bookingId, traceId: "t" }));
    for (const who of [OWNER_C1, AGENT_C1, ADVISOR, actor("comp", "COMPLIANCE"), actor("job", "SYSTEM_JOB")]) {
      expect(await completeWorkOrder(deps, { actor: who, workOrderId: opened.workOrderId, completionOdometerKm: 74_300, traceId: "t" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", detail: "ROLE_NOT_PERMITTED" } });
      expect(await openWorkOrder(deps, { actor: who, bookingId: booking.bookingId, traceId: "t" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    }
    expect(await db.serviceRecord.count({ where: { vehicleId: V.v1 } })).toBe(1); // solo el histórico del seed
  });

  it("el personal de otro taller no puede cerrar la orden", async () => {
    const booking = await bookV1();
    const deps = depsAt(db, 60);
    const opened = must(await openWorkOrder(deps, { actor: WS_T1, bookingId: booking.bookingId, traceId: "t" }));
    expect(await completeWorkOrder(deps, { actor: WS_T2, workOrderId: opened.workOrderId, completionOdometerKm: 74_300, traceId: "t" })).toEqual({ ok: false, error: { code: "UNAUTHORIZED", detail: "OTHER_WORKSHOP" } });
  });

  it("cierre con odómetro menor al verificado → ODOMETER_ROLLBACK; cierre repetido idempotente", async () => {
    const booking = await bookV1();
    const deps = depsAt(db, 60);
    const opened = must(await openWorkOrder(deps, { actor: WS_T1, bookingId: booking.bookingId, traceId: "t" }));
    expect(await completeWorkOrder(deps, { actor: WS_T1, workOrderId: opened.workOrderId, completionOdometerKm: 60_000, traceId: "t" })).toMatchObject({ ok: false, error: { code: "ODOMETER_ROLLBACK" } });
    must(await completeWorkOrder(deps, { actor: WS_T1, workOrderId: opened.workOrderId, completionOdometerKm: 74_300, traceId: "t" }));
    expect(must(await completeWorkOrder(deps, { actor: WS_T1, workOrderId: opened.workOrderId, completionOdometerKm: 74_300, traceId: "t" }))).toMatchObject({ duplicate: true });
    expect(await completeWorkOrder(deps, { actor: WS_T1, workOrderId: opened.workOrderId, completionOdometerKm: 74_400, traceId: "t" })).toMatchObject({ ok: false, error: { code: "WORK_ORDER_STATE" } });
    expect(await db.serviceRecord.count({ where: { workOrderId: opened.workOrderId } })).toBe(1);
  });

  it("taller caído al cerrar → error reintentable y nada registrado", async () => {
    const booking = await bookV1();
    const deps = depsAt(db, 60);
    const opened = must(await openWorkOrder(deps, { actor: WS_T1, bookingId: booking.bookingId, traceId: "t" }));
    await activateScenario(db, "WORKSHOP_DOWN");
    expect(await completeWorkOrder(deps, { actor: WS_T1, workOrderId: opened.workOrderId, completionOdometerKm: 74_300, traceId: "t" })).toMatchObject({ ok: false, error: { code: "WORKSHOP_UNAVAILABLE", retryable: true } });
    expect(await db.workOrder.findUniqueOrThrow({ where: { id: opened.workOrderId } })).toMatchObject({ status: "IN_PROGRESS" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("IN_SERVICE");
  });
});

describe("CRM MOCK y casos humanos", () => {
  it("una caída del CRM no revierte una reserva confirmada por el taller", async () => {
    await activateScenario(db, "CRM_DOWN", null);
    const booking = await bookV1();
    expect(booking.status).toBe("CONFIRMED");
    expect(await db.mockCrmInteraction.count()).toBe(0);
    expect((await findJourney(db, KEY_V1))!.state).toBe("BOOKED");
  });

  it("openHumanCase: asigna al asesor de cartera, mueve el journey y registra en CRM una sola vez", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    const deps = depsAt(db);
    const cmd = { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, reason: "CUSTOMER_REQUEST" as const, priority: "NORMAL" as const, summary: "El cliente pide hablar con un asesor", traceId: "t", idempotencyKey: "case-1" };
    const r = must(await openHumanCase(deps, cmd));
    expect(r).toMatchObject({ assigneeId: DEMO_IDS.actors.advisor, journeyState: "HUMAN_REVIEW", duplicate: false });
    expect(must(await openHumanCase(deps, cmd))).toMatchObject({ caseId: r.caseId, duplicate: true });
    expect(await db.mockCrmInteraction.count({ where: { kind: "HUMAN_CASE_OPENED" } })).toBe(1);
    expect(await openHumanCase(deps, { ...cmd, reason: "SAFETY_ESCALATION", idempotencyKey: "case-2" })).toEqual({ ok: false, error: { code: "INVALID_INPUT", detail: "USE_SAFETY_SIGNAL" } });
    expect(await openHumanCase(deps, { ...cmd, actor: OWNER_C2, idempotencyKey: "case-3" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
});
