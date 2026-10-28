import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getServiceHistory } from "@/application/get-service-history";
import { getVehicleProfile } from "@/application/get-vehicle-profile";
import { runEvaluationJob } from "@/application/run-evaluation-job";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { ActorContext } from "@/domain/policies/access-policy";
import { fixedClock } from "@/infra/clock";
import { DEMO_IDS, SEED_SOURCE_PREFIX } from "@/infra/seed/demo-seed";
import { expectDbRejection } from "./helpers/assertions";
import { MockNotificationPort } from "@/integrations/mock/mock-notifications";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const clock = fixedClock(DEMO_NOW.toISOString());
const deps = { db, clock };
const jobDeps = () => ({ db, clock, notifications: new MockNotificationPort() });
const { vehicles: V, customers: C, actors: A, workshops: W } = DEMO_IDS;

const owner = (actorId: string, customerId: string): ActorContext => ({ actorId, role: "OWNER", customerId, workshopId: null });
const OWNER_C1 = owner(A.ownerC1, C.c1);
const OWNER_C2 = owner(A.ownerC2, C.c2);
const OWNER_C3 = owner(A.ownerC3, C.c3);
const SYSTEM_JOB: ActorContext = { actorId: A.systemJob, role: "SYSTEM_JOB", customerId: null, workshopId: null };

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("IT-01 seed sintético aplicado", () => {
  it("4 vehículos, 3 clientes, 2 talleres y una única política activa de cada tipo", async () => {
    expect(await db.vehicle.count()).toBe(4);
    expect(await db.customer.count()).toBe(3);
    expect(await db.workshop.count()).toBe(2);
    expect(await db.communicationPolicy.count({ where: { isActive: true } })).toBe(1);
    expect(await db.dataQualityPolicy.count({ where: { isActive: true } })).toBe(1);
  });

  it("todo dato técnico es SYNTHETIC y rotula su fuente (ADR-011)", async () => {
    for (const rows of [
      await db.vehicle.findMany(),
      await db.customer.findMany(),
      await db.vehicleSpec.findMany(),
      await db.odometerReading.findMany(),
      await db.serviceRecord.findMany(),
      await db.workOrder.findMany(),
    ]) {
      for (const row of rows) {
        expect(row.dataOrigin).toBe("SYNTHETIC");
        expect(row.syntheticSourceRef).toMatch(/^SYNTHETIC-DEMO:/);
      }
    }
    const plan = await db.maintenancePlanVersion.findUniqueOrThrow({ where: { id: DEMO_IDS.planVersion } });
    expect(plan).toMatchObject({ status: "VALIDATED", dataOrigin: "SYNTHETIC" });
    expect(plan.sourceRef).toMatch(/^SYNTHETIC-DEMO:/);
    const specs = await db.vehicleSpec.findMany();
    expect(new Set(specs.map((s) => s.make))).toEqual(new Set(["DemoMotors"]));
  });

  it("re-ejecutar el seed sobre una base sembrada no modifica nada", async () => {
    const { seedDemoData } = await import("@/infra/seed/demo-seed");
    expect(await seedDemoData(db)).toEqual({ seeded: false });
    expect(await db.vehicle.count()).toBe(4);
  });
});

describe("IT-02 perfil del vehículo para su titular", () => {
  it("devuelve el perfil de V1 sin placa completa ni datos personales", async () => {
    const result = await getVehicleProfile(deps, { actor: OWNER_C1, vehicleId: V.v1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const profile = result.value;
    expect(profile).toMatchObject({
      vehicleId: V.v1,
      vehicleAlias: "Sedán Demo 2021",
      plateMasked: "••••01",
      spec: { make: "DemoMotors", engineCode: "DEMO-1.6", timingDrive: "CHAIN", specVerified: true },
      odometer: { valueKm: 74_200, provenance: "OWNER_DECLARED", verification: "UNVERIFIED", dataOrigin: "SYNTHETIC", ageDays: 0 },
      dataOrigin: "SYNTHETIC",
    });
    const serialized = JSON.stringify(profile);
    for (const pii of ["DMO001", "c1@demo.invalid", "+57", "Cliente Demo", C.c1]) {
      expect(serialized).not.toContain(pii);
    }
  });
});

describe("IT-03 historial con procedencia y origen", () => {
  it("distingue lo acreditado por el taller, lo declarado por el cliente y lo sintético", async () => {
    const result = await getServiceHistory(deps, { actor: OWNER_C1, vehicleId: V.v1 });
    if (!result.ok) throw new Error(result.error.code);
    const { serviceRecords, odometerReadings } = result.value;

    expect(serviceRecords).toEqual([
      expect.objectContaining({
        serviceCode: "ENGINE_OIL_FILTER",
        performedOn: "2026-04-01",
        odometerKm: 70_000,
        provenance: "WORKSHOP_VERIFIED",
        dataOrigin: "SYNTHETIC",
        evidenceAvailable: true,
      }),
    ]);
    expect(odometerReadings.map((r) => [r.valueKm, r.provenance, r.verification])).toEqual([
      [74_200, "OWNER_DECLARED", "UNVERIFIED"],
      [70_000, "WORKSHOP_VERIFIED", "VERIFIED"],
    ]);
    for (const r of [...serviceRecords, ...odometerReadings]) {
      expect(r.syntheticSourceRef?.startsWith(SEED_SOURCE_PREFIX)).toBe(true);
    }
  });
});

describe("IT-04 acceso denegado por defecto", () => {
  it("C2 no puede leer V1", async () => {
    expect(await getVehicleProfile(deps, { actor: OWNER_C2, vehicleId: V.v1 })).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", detail: "NO_ACTIVE_OWNERSHIP" },
    });
    expect((await getServiceHistory(deps, { actor: OWNER_C2, vehicleId: V.v1 })).ok).toBe(false);
  });

  it("el titular anterior (C3) ya no accede a V1", async () => {
    expect((await getVehicleProfile(deps, { actor: OWNER_C3, vehicleId: V.v1 })).ok).toBe(false);
  });

  it("un vehículo inexistente responde igual que uno ajeno", async () => {
    expect(await getVehicleProfile(deps, { actor: OWNER_C1, vehicleId: "veh-no-existe" })).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", detail: "NO_ACTIVE_OWNERSHIP" },
    });
  });

  it("taller: solo con servicio u orden en su taller", async () => {
    const t1: ActorContext = { actorId: A.workshopT1, role: "WORKSHOP_COORDINATOR", customerId: null, workshopId: W.t1 };
    expect((await getVehicleProfile(deps, { actor: t1, vehicleId: V.v1 })).ok).toBe(true);
    expect((await getVehicleProfile(deps, { actor: t1, vehicleId: V.v3 })).ok).toBe(false);
  });
});

describe("IT-05 job de evaluación y consentimiento (EX-04)", () => {
  it("sin MAINTENANCE_REMINDERS el recordatorio queda SUPPRESSED, sin consentEventId y con motivo", async () => {
    const items = await runEvaluationJob(jobDeps(), { actor: SYSTEM_JOB, traceId: "trc-it05" });

    const v2Oil = items.find((i) => i.vehicleId === V.v2 && i.serviceCode === "ENGINE_OIL_FILTER");
    expect(v2Oil?.evaluation).toMatchObject({ status: "DUE" });
    expect(v2Oil?.reminder).toMatchObject({ outcome: "SUPPRESSED", channel: "WHATSAPP", suppressionReason: "CONSENT_REQUIRED" });

    const suppressed = await db.outboundMessage.findMany({ where: { status: "SUPPRESSED" } });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({
      customerId: C.c2,
      vehicleId: V.v2,
      purpose: "MAINTENANCE_REMINDERS",
      consentEventId: null,
      suppressionReason: "CONSENT_REQUIRED",
      dataOrigin: "SYNTHETIC",
    });
    // Completado en Fase 3: el journey registra la supresión (CONTACT_SUPPRESSED).
    const journey = await db.journeyInstance.findFirstOrThrow({ where: { vehicleId: V.v2, serviceCode: "ENGINE_OIL_FILTER" }, include: { events: { orderBy: { seq: "asc" } } } });
    expect(journey.state).toBe("CONTACT_SUPPRESSED");
    expect(journey.events.map((e) => [e.type, e.toState])).toEqual([
      ["EVALUATED", "NEED_DETECTED"],
      ["CONTACT_SUPPRESSED", "CONTACT_SUPPRESSED"],
    ]);
  });

  it("con consentimiento vigente el recordatorio se registra (simulado) con la evidencia usada", async () => {
    const items = await runEvaluationJob(jobDeps(), { actor: SYSTEM_JOB, traceId: "trc-it05b" });
    const v1Oil = items.find((i) => i.vehicleId === V.v1 && i.serviceCode === "ENGINE_OIL_FILTER");
    expect(v1Oil?.evaluation).toMatchObject({ status: "UPCOMING" });
    expect(v1Oil?.reminder).toMatchObject({
      outcome: "SIMULATED_SENT",
      channel: "WHATSAPP",
      consentEventId: `cons-${C.c1}-rem-wa-ev1`,
    });
  });

  it("solo los estados UPCOMING/DUE/OVERDUE generan mensajes; UNKNOWN, NOT_DUE y NOT_APPLICABLE no", async () => {
    const items = await runEvaluationJob(jobDeps(), { actor: SYSTEM_JOB, traceId: "trc-it05c" });
    const summary = Object.fromEntries(
      items.map((i) => [`${i.vehicleId}/${i.serviceCode}`, "status" in i.evaluation ? i.evaluation.status : i.evaluation.error.code]),
    );
    expect(summary).toEqual({
      [`${V.v1}/ENGINE_OIL_FILTER`]: "UPCOMING",
      [`${V.v1}/TIMING_BELT`]: "NOT_APPLICABLE",
      [`${V.v2}/ENGINE_OIL_FILTER`]: "DUE",
      [`${V.v2}/TIMING_BELT`]: "UNKNOWN",
      [`${V.v3}/ENGINE_OIL_FILTER`]: "NOT_DUE",
      [`${V.v3}/TIMING_BELT`]: "NOT_APPLICABLE",
      [`${V.v4}/ENGINE_OIL_FILTER`]: "UNKNOWN",
      [`${V.v4}/TIMING_BELT`]: "UNKNOWN",
    });
    expect(await db.outboundMessage.count()).toBe(2);
    expect(await db.maintenanceEvaluation.count()).toBe(8);
  });
});

describe("IT-06 eventos del journey append-only", () => {
  it("UPDATE y DELETE sobre JourneyEvent son rechazados por el trigger", async () => {
    const journey = await db.journeyInstance.create({
      data: { vehicleId: V.v1, serviceCode: "ENGINE_OIL_FILTER", state: "NEED_DETECTED", version: 1 },
    });
    const event = await db.journeyEvent.create({
      data: {
        journeyId: journey.id,
        seq: 1,
        type: "EVALUATED",
        fromState: "ACTIVATED",
        toState: "NEED_DETECTED",
        payload: {},
        actorId: A.systemJob,
        actorRole: "SYSTEM_JOB",
        traceId: "trc-it06",
        idempotencyKey: "it06-evaluated",
      },
    });

    await expectDbRejection(db.journeyEvent.update({ where: { id: event.id }, data: { type: "TAMPERED" } }), /append-only: JourneyEvent no permite UPDATE/);
    await expectDbRejection(db.journeyEvent.delete({ where: { id: event.id } }), /append-only: JourneyEvent no permite DELETE/);
    expect(await db.journeyEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ type: "EVALUATED" });
  });
});
