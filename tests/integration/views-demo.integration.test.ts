import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedLlm } from "@/agent/llm/scripted-llm";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { fixedClock } from "@/infra/clock";
import { buildContainer, type Container } from "@/infra/container";
import { handleAgentTurn, handleBookingConfirm } from "@/infra/http/handlers";
import { handleCases, handleDemoConfig, handleDemoSlotTaken, handleDemoStart, handleMe, handleResolveCase, handleVehicleOverview, handleVehicleTrace } from "@/infra/http/view-handlers";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { SESSION_COOKIE, signSession } from "@/infra/session";
import { runJob } from "./helpers/agent";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const SECRET = "views-test-session-secret-0123456789abcdef";
const { vehicles: V, actors: A } = DEMO_IDS;

const container = (env: Record<string, string> = {}): Container =>
  buildContainer({ SESSION_SECRET: SECRET, LOG_HASH_SECRET: SECRET, AGENT_TURNS_PER_MINUTE: "100", DEMO_MODE: "true", ...env }, { db, clock: fixedClock(DEMO_NOW.toISOString()), llm: new ScriptedLlm() });

const cookieFor = (actorId: string) => `${SESSION_COOKIE}=${signSession({ actorId, exp: Math.floor(DEMO_NOW.getTime() / 1000) + 3600 }, SECRET)}`;
const req = (url: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${url}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
const cookieFrom = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

async function startRun(c: Container, scenario: "A" | "B" | "C" | "D") {
  const res = await handleDemoStart(req("/api/demo/scenarios", { body: { scenario } }), c);
  expect(res.status).toBe(200);
  return { run: (await res.json()) as { runId: string; vehicleId: string; ownerActorId: string; serviceCode: string }, cookie: cookieFrom(res) };
}

async function turn(c: Container, cookie: string, vehicleId: string, message: string, extra: Record<string, string> = {}) {
  const res = await handleAgentTurn(req("/api/agent/turn", { body: { vehicleId, message, ...extra }, cookie }), c);
  expect(res.status).toBe(200);
  return (await res.json()) as { sessionId: string; journey: { state: string }; cards: Array<{ type: string; confirmationToken?: string; caseId?: string }> };
}

async function toIntent(c: Container, cookie: string, vehicleId: string) {
  let t = await turn(c, cookie, vehicleId, "¿Qué mantenimiento le toca a mi carro?");
  for (const m of ["¿Cuánto cuesta?", "¿Qué horarios hay?", "Reserva el primer horario"]) t = await turn(c, cookie, vehicleId, m, { sessionId: t.sessionId });
  expect(t.journey.state).toBe("AWAITING_CONFIRMATION");
  return t.cards.find((x) => x.type === "BOOKING_INTENT")!.confirmationToken!;
}

beforeEach(async () => {
  await resetAndSeed(db);
  await runJob(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Demo: corridas aisladas (solo DEMO_MODE)", () => {
  it("sin DEMO_MODE los endpoints demo responden 404 y la configuración no expone escenarios", async () => {
    const c = container({ DEMO_MODE: "false" });
    expect((await handleDemoStart(req("/api/demo/scenarios", { body: { scenario: "A" } }), c)).status).toBe(404);
    expect((await handleDemoSlotTaken(req("/api/demo/slot-taken", { body: {}, cookie: cookieFor(A.ownerC1) }), c)).status).toBe(404);
    expect(await (await handleDemoConfig(req("/api/demo/config"), c)).json()).toMatchObject({ demoMode: false, scenarios: [], llm: { provider: "SCRIPTED", simulated: true } });
  });

  it("clona el escenario en datos sintéticos nuevos, sin tocar la plantilla, y entra con la sesión del propietario nuevo", async () => {
    const c = container();
    const before = await db.vehicle.count();
    const { run, cookie } = await startRun(c, "A");
    expect(await db.vehicle.count()).toBe(before + 1);
    const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: run.vehicleId } });
    expect(vehicle).toMatchObject({ dataOrigin: "SYNTHETIC" });
    expect(vehicle.syntheticSourceRef).toMatch(/^SYNTHETIC-DEMO:demo-run\//);
    expect(vehicle.plate).toMatch(/^DEMO/);
    expect(await db.actorAccount.findUniqueOrThrow({ where: { id: run.ownerActorId } })).toMatchObject({ role: "OWNER", isDemo: true });

    const me = await (await handleMe(req("/api/me", { cookie }), c)).json();
    expect(me.vehicles.map((v: { vehicleId: string }) => v.vehicleId)).toEqual([run.vehicleId]);

    const ov = await (await handleVehicleOverview(req(`/api/vehicles/${run.vehicleId}/overview`, { cookie }), c, run.vehicleId)).json();
    // Mismo resultado del motor que la plantilla V1 (UPCOMING, 800 km): la clonación no altera reglas ni datos.
    expect(ov.evaluation).toMatchObject({ status: "UPCOMING", remainingKm: 800, containsSyntheticData: true });
    expect(ov.journey.state).toBe("NEED_DETECTED");
    // La plantilla sigue igual y no es visible para el propietario nuevo.
    expect((await handleVehicleOverview(req(`/api/vehicles/${V.v1}/overview`, { cookie }), c, V.v1)).status).toBe(403);
  });

  it("limita las corridas por IP", async () => {
    const c = container({ DEMO_RUNS_PER_10_MIN: "1" });
    expect((await handleDemoStart(req("/api/demo/scenarios", { body: { scenario: "A" }, headers: { "x-forwarded-for": "203.0.113.9" } }), c)).status).toBe(200);
    const res = await handleDemoStart(req("/api/demo/scenarios", { body: { scenario: "A" }, headers: { "x-forwarded-for": "203.0.113.9" } }), c);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("escenario D: el cupo tomado provoca SLOT_CONFLICT al confirmar, sin crear reserva", async () => {
    const c = container();
    const { run, cookie } = await startRun(c, "D");
    expect((await handleDemoSlotTaken(req("/api/demo/slot-taken", { body: {}, cookie }), c)).status).not.toBe(200);
    const token = await toIntent(c, cookie, run.vehicleId);
    expect((await handleDemoSlotTaken(req("/api/demo/slot-taken", { body: {}, cookie }), c)).status).toBe(200);
    const res = await handleBookingConfirm(req("/api/bookings/confirm", { body: { confirmationToken: token }, cookie }), c);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "SLOT_CONFLICT" } });
    expect(await db.booking.count({ where: { vehicleId: run.vehicleId, status: "CONFIRMED" } })).toBe(0);
  });
});

describe("Vistas: portal, trazas y bandeja", () => {
  it("overview nunca expone el token de confirmación y entrega folio solo si está confirmada", async () => {
    const c = container();
    const { run, cookie } = await startRun(c, "A");
    const token = await toIntent(c, cookie, run.vehicleId);
    const pending = await (await handleVehicleOverview(req(`/api/vehicles/${run.vehicleId}/overview`, { cookie }), c, run.vehicleId)).json();
    expect(pending.pendingIntent).toMatchObject({ intentId: expect.any(String) });
    expect(JSON.stringify(pending)).not.toContain(token);
    expect((await handleBookingConfirm(req("/api/bookings/confirm", { body: { confirmationToken: token }, cookie }), c)).status).toBe(200);
    const booked = await (await handleVehicleOverview(req(`/api/vehicles/${run.vehicleId}/overview`, { cookie }), c, run.vehicleId)).json();
    expect(booked.booking).toMatchObject({ status: "CONFIRMED", folio: expect.stringMatching(/^FOLIO-/), source: "MOCK" });
    expect(booked.journey.state).toBe("BOOKED");
  });

  it("trazas: titular sí; otro propietario no; compliance solo con justificación y queda auditado", async () => {
    const c = container();
    const { run, cookie } = await startRun(c, "A");
    const token = await toIntent(c, cookie, run.vehicleId);
    const res = await handleVehicleTrace(req(`/api/vehicles/${run.vehicleId}/trace`, { cookie }), c, run.vehicleId);
    expect(res.status).toBe(200);
    const trace = await res.json();
    expect(trace.journey).toMatchObject({ state: "AWAITING_CONFIRMATION", consistent: true, agentPaused: false });
    expect(trace.toolCalls.map((t: { tool: string }) => t.tool)).toEqual(expect.arrayContaining(["evaluateMaintenance", "getQuote", "getAvailableSlots", "prepareBooking"]));
    expect(trace.toolCalls.find((t: { tool: string }) => t.tool === "getQuote").source).toBe("MOCK");
    expect(JSON.stringify(trace)).not.toContain(token);
    expect(JSON.stringify(trace)).not.toMatch(/confirmationToken|DEMO[0-9A-F]{8}/);

    expect((await handleVehicleTrace(req(`/api/vehicles/${run.vehicleId}/trace`, { cookie: cookieFor(A.ownerC1) }), c, run.vehicleId)).status).toBe(403);
    const compliance = cookieFor(A.compliance);
    expect((await handleVehicleTrace(req(`/api/vehicles/${run.vehicleId}/trace`, { cookie: compliance }), c, run.vehicleId)).status).toBe(403);
    const audited = await handleVehicleTrace(req(`/api/vehicles/${run.vehicleId}/trace`, { cookie: compliance, headers: { "x-audit-justification": "Revisión de reclamo del cliente 2026-10" } }), c, run.vehicleId);
    expect(audited.status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "AUDIT_READ", entityId: run.vehicleId } })).toBe(1);
  });

  it("bandeja: escenario B abre caso para el asesor; propietario no accede; el asesor lo resuelve con una acción permitida", async () => {
    const c = container();
    const { run, cookie } = await startRun(c, "B");
    const t = await turn(c, cookie, run.vehicleId, "¿Debo cambiar la correa de distribución?", { serviceCode: "TIMING_BELT" });
    expect(t.cards.map((x) => x.type)).toContain("HUMAN_CASE");
    expect((await handleCases(req("/api/cases", { cookie }), c)).status).toBe(403);

    const advisor = cookieFor(A.advisor);
    const { cases } = await (await handleCases(req("/api/cases", { cookie: advisor }), c)).json();
    const kase = cases.find((k: { vehicle: { vehicleId: string } }) => k.vehicle.vehicleId === run.vehicleId);
    expect(kase).toMatchObject({ reason: "INSUFFICIENT_HISTORY", canResolve: true, allowedOutcomes: ["REEVALUATE", "CLOSE"], journey: { state: "HUMAN_REVIEW", agentPaused: true }, openedByRole: expect.not.stringMatching(/HUMANO/) });

    // Una decisión no permitida para el estado se rechaza; el propietario tampoco puede resolver.
    expect((await handleResolveCase(req(`/api/cases/${kase.caseId}/resolve`, { body: { outcome: "CLEARED_FOR_SERVICE", resolution: "no aplica aquí" }, cookie: advisor }), c, kase.caseId)).status).toBe(409);
    expect((await handleResolveCase(req(`/api/cases/${kase.caseId}/resolve`, { body: { outcome: "CLOSE", resolution: "intento del propietario" }, cookie }), c, kase.caseId)).status).toBe(403);
    expect((await handleResolveCase(req(`/api/cases/${kase.caseId}/resolve`, { body: { outcome: "CLOSE", resolution: "x" }, cookie: advisor }), c, kase.caseId)).status).toBe(400);
    const ok = await handleResolveCase(req(`/api/cases/${kase.caseId}/resolve`, { body: { outcome: "CLOSE", resolution: "Se agenda inspección presencial." }, cookie: advisor }), c, kase.caseId);
    expect(ok.status).toBe(200);
    expect(await db.humanCase.findUniqueOrThrow({ where: { id: kase.caseId } })).toMatchObject({ status: "RESOLVED" });
  });
});
