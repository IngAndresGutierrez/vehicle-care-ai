import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateVehicle } from "@/application/evaluate-vehicle";
import { buildEvaluationContext } from "@/application/evaluation-context-builder";
import { evaluate } from "@/domain/maintenance-engine";
import { DEMO_NOW, DEMO_POLICIES, v1OilInput } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { ActorContext } from "@/domain/policies/access-policy";
import { fixedClock } from "@/infra/clock";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { expectDbRejection } from "./helpers/assertions";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const deps = { db, clock: fixedClock(DEMO_NOW.toISOString()) };
const { vehicles: V, customers: C, actors: A, specs: S } = DEMO_IDS;
const OIL = "ENGINE_OIL_FILTER";
const BELT = "TIMING_BELT";
const JOB: ActorContext = { actorId: A.systemJob, role: "SYSTEM_JOB", customerId: null, workshopId: null };

const run = (vehicleId: string, serviceCode: string, actor: ActorContext = JOB) =>
  evaluateVehicle(deps, { actor, vehicleId, serviceCode, traceId: "trc-eval" });

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("evaluate-vehicle — V1 reproduce el ejemplo del PRD desde PostgreSQL", () => {
  it("UPCOMING por 800 km, igual que el motor sobre el fixture", async () => {
    const outcome = await run(V.v1, OIL);
    if (!outcome.ok) throw new Error(outcome.error.code);
    const fromFixture = evaluate(v1OilInput(), DEMO_POLICIES, DEMO_NOW);

    expect(outcome.value.result.status).toBe("UPCOMING");
    expect(outcome.value.result.technical).toEqual(fromFixture.technical);
    expect(outcome.value.result.communication).toEqual(fromFixture.communication);
    expect(outcome.value.result.reasons).toEqual(fromFixture.reasons);
  });

  it("persiste una evaluación trazable: hash, versión del motor, traza, fuente, plan y origen sintético", async () => {
    const outcome = await run(V.v1, OIL);
    if (!outcome.ok) throw new Error(outcome.error.code);
    const row = await db.maintenanceEvaluation.findUniqueOrThrow({ where: { id: outcome.value.evaluationId } });

    expect(row).toMatchObject({
      vehicleId: V.v1,
      serviceCode: OIL,
      status: "UPCOMING",
      technicalStatus: "NOT_DUE",
      communicationStatus: "UPCOMING",
      dueByKm: 75_000,
      remainingKm: 800,
      remainingDays: 155,
      triggeredBy: "KM",
      reachedBy: null,
      suggestedAction: "OFFER_QUOTE",
      planVersionId: DEMO_IDS.planVersion,
      planVersionLabel: "demo-2026.10-r1",
      ruleId: "rule-demo-oil",
      commPolicyVersion: "demo-comm-v1",
      dataQualityPolicyVersion: "demo-dq-v1",
      engineVersion: "1.0.0",
      inputHash: outcome.value.result.inputHash,
      containsSyntheticData: true,
      traceId: "trc-eval",
    });
    expect(row.dueByDate?.toISOString().slice(0, 10)).toBe("2027-04-01");
    expect(row.asOfLocalDate.toISOString().slice(0, 10)).toBe("2026-10-28");
    expect(row.planSourceRef).toMatch(/^SYNTHETIC-DEMO:/);
    expect(row.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.syntheticSources).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^plan:planv-demo-1 \(SYNTHETIC-DEMO:/),
        "serviceRecord:svc-demo-1",
        "odometerReading:odo-demo-1",
        "communicationPolicy:demo-comm-v1",
      ]),
    );
    expect((row.decisionTrace as Array<{ step: string }>).map((s) => s.step)).toContain("communication");
    expect(row.inputSnapshot).toMatchObject({ vehicleId: V.v1, serviceCode: OIL, lastService: { recordId: "svc-demo-1" } });
  });

  it("es reproducible y acumula historial: dos evaluaciones idénticas → mismo hash, dos filas", async () => {
    const a = await run(V.v1, OIL);
    const b = await run(V.v1, OIL);
    if (!a.ok || !b.ok) throw new Error("evaluación fallida");
    expect(a.value.result.inputHash).toBe(b.value.result.inputHash);
    expect(await db.maintenanceEvaluation.count({ where: { vehicleId: V.v1 } })).toBe(2);
  });

  it("la evaluación persistida es append-only", async () => {
    const outcome = await run(V.v1, OIL);
    if (!outcome.ok) throw new Error(outcome.error.code);
    await expectDbRejection(
      db.maintenanceEvaluation.update({ where: { id: outcome.value.evaluationId }, data: { status: "DUE" } }),
      /append-only: MaintenanceEvaluation/,
    );
  });
});

describe("evaluate-vehicle — escenarios del seed", () => {
  it("ADR-009: V2 correa con regla demo validada y sin constancia → UNKNOWN[INSUFFICIENT_HISTORY], sin cifras", async () => {
    const rule = await db.maintenanceRule.findUniqueOrThrow({ where: { id: "rule-demo-belt" }, include: { planVersion: true } });
    expect(rule).toMatchObject({ appliesToTimingDrive: "BELT", planVersion: { status: "VALIDATED", dataOrigin: "SYNTHETIC" } });

    const outcome = await run(V.v2, BELT);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.value.result).toMatchObject({ status: "UNKNOWN", reasons: ["INSUFFICIENT_HISTORY"], suggestedAction: "HUMAN_REVIEW" });
    const row = await db.maintenanceEvaluation.findUniqueOrThrow({ where: { id: outcome.value.evaluationId } });
    expect(row).toMatchObject({ technicalStatus: "UNKNOWN", communicationStatus: null, dueByKm: null, dueByDate: null, remainingKm: null });
  });

  it("V2 aceite con factura del propietario anterior → DUE (límite técnico alcanzado)", async () => {
    const outcome = await run(V.v2, OIL);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.value.result).toMatchObject({ status: "DUE", technical: { status: "DUE", reachedBy: "KM" } });
  });

  it("V3: aceite NOT_DUE y correa NOT_APPLICABLE (cadena)", async () => {
    const oil = await run(V.v3, OIL);
    const belt = await run(V.v3, BELT);
    if (!oil.ok || !belt.ok) throw new Error("evaluación fallida");
    expect(oil.value.result.status).toBe("NOT_DUE");
    expect(belt.value.result.status).toBe("NOT_APPLICABLE");
  });

  it("V4: motor no identificado → UNKNOWN[ENGINE_UNIDENTIFIED] (AC03)", async () => {
    const outcome = await run(V.v4, OIL);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.value.result).toMatchObject({ status: "UNKNOWN", reasons: ["ENGINE_UNIDENTIFIED"] });
  });
});

describe("evaluate-vehicle — autorización", () => {
  it("el titular evalúa su vehículo; otro cliente recibe UNAUTHORIZED y no se persiste nada", async () => {
    const ownerC1: ActorContext = { actorId: A.ownerC1, role: "OWNER", customerId: C.c1, workshopId: null };
    const ownerC2: ActorContext = { actorId: A.ownerC2, role: "OWNER", customerId: C.c2, workshopId: null };
    expect((await run(V.v1, OIL, ownerC1)).ok).toBe(true);
    expect(await run(V.v1, OIL, ownerC2)).toEqual({ ok: false, error: { code: "UNAUTHORIZED", detail: "NO_ACTIVE_OWNERSHIP" } });
    expect(await db.maintenanceEvaluation.count()).toBe(1);
  });
});

describe("EvaluationContextBuilder — solo selecciona y mapea datos", () => {
  it("excluye lecturas rechazadas y lecturas reemplazadas por una corrección", async () => {
    await db.odometerReading.createMany({
      data: [
        { id: "odo-rejected", vehicleId: V.v1, valueKm: 99_999, observedAt: new Date("2026-10-28T10:00:00-05:00"), provenance: "OWNER_DECLARED", verification: "REJECTED", recordedById: A.ownerC1, dataOrigin: "SYNTHETIC", syntheticSourceRef: "SYNTHETIC-DEMO:test#odo-rejected" },
        { id: "odo-typo", vehicleId: V.v1, valueKm: 74_900, observedAt: new Date("2026-10-28T10:30:00-05:00"), provenance: "OWNER_DECLARED", recordedById: A.ownerC1, dataOrigin: "SYNTHETIC", syntheticSourceRef: "SYNTHETIC-DEMO:test#odo-typo" },
        { id: "odo-fix", vehicleId: V.v1, valueKm: 74_300, observedAt: new Date("2026-10-28T11:00:00-05:00"), provenance: "OWNER_DECLARED", supersedesId: "odo-typo", recordedById: A.ownerC1, dataOrigin: "SYNTHETIC", syntheticSourceRef: "SYNTHETIC-DEMO:test#odo-fix" },
      ],
    });
    const ctx = await buildEvaluationContext(db, V.v1, OIL, DEMO_NOW);
    if (!ctx.ok) throw new Error(ctx.error.code);
    expect(ctx.value.input.odometer).toMatchObject({ readingId: "odo-fix", valueKm: 74_300 });
    expect(ctx.value.input.odometerHistory.map((r) => r.valueKm)).toEqual([70_000, 74_200]);
  });

  it("mapea fechas de calendario e instantes sin desfase de zona", async () => {
    const ctx = await buildEvaluationContext(db, V.v1, OIL, DEMO_NOW);
    if (!ctx.ok) throw new Error(ctx.error.code);
    expect(ctx.value.input.lastService).toMatchObject({ performedOn: "2026-04-01", provenance: "WORKSHOP_VERIFIED" });
    expect(ctx.value.input.odometer?.observedAt).toBe("2026-10-28T14:00:00.000Z");
    expect(ctx.value.policies.communication.policyVersion).toBe("demo-comm-v1");
  });

  it("prefiere la versión VALIDATED aunque exista un borrador más nuevo", async () => {
    await db.maintenancePlanVersion.create({
      data: { id: "planv-demo-draft", planId: DEMO_IDS.plan, version: "demo-2026.11-draft", status: "DRAFT", sourceRef: "SYNTHETIC-DEMO: borrador", dataOrigin: "SYNTHETIC", effectiveFrom: new Date("2026-10-20T00:00:00Z") },
    });
    const ctx = await buildEvaluationContext(db, V.v1, OIL, DEMO_NOW);
    if (!ctx.ok) throw new Error(ctx.error.code);
    expect(ctx.value.input.plan?.planVersionId).toBe(DEMO_IDS.planVersion);
  });

  it("solo hay un borrador → el motor responde PLAN_NOT_VERIFIED", async () => {
    await db.maintenancePlan.create({ data: { id: "plan-draft-only", name: "Plan borrador (SINTÉTICO)" } });
    await db.maintenancePlanVersion.create({
      data: { id: "planv-draft-only", planId: "plan-draft-only", version: "d1", status: "DRAFT", sourceRef: "SYNTHETIC-DEMO: borrador", dataOrigin: "SYNTHETIC" },
    });
    await db.planApplicability.update({ where: { id: `pa-${S.v3}` }, data: { planId: "plan-draft-only" } });
    const outcome = await run(V.v3, OIL);
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(outcome.value.result.reasons).toEqual(["PLAN_NOT_VERIFIED"]);
  });

  it("dos planes aplicables a la misma especificación → AMBIGUOUS_PLAN, sin persistir", async () => {
    await db.maintenancePlan.create({ data: { id: "plan-dup", name: "Plan duplicado (SINTÉTICO)" } });
    await db.planApplicability.create({ data: { planId: "plan-dup", specId: S.v1 } });
    const outcome = await run(V.v1, OIL);
    expect(outcome).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_PLAN" } });
    expect(await db.maintenanceEvaluation.count()).toBe(0);
  });

  it("sin política de comunicación activa → POLICY_MISSING", async () => {
    await db.communicationPolicy.update({ where: { id: DEMO_IDS.communicationPolicy }, data: { isActive: false } });
    expect(await run(V.v1, OIL)).toMatchObject({ ok: false, error: { code: "POLICY_MISSING" } });
  });

  it("vehículo inexistente → VEHICLE_NOT_FOUND", async () => {
    expect(await buildEvaluationContext(db, "veh-no-existe", OIL, DEMO_NOW)).toMatchObject({ ok: false, error: { code: "VEHICLE_NOT_FOUND" } });
  });
});
