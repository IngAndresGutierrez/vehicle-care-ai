import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ToolGateway, type AgentSessionContext } from "@/agent/gateway";
import { applyJourneyEvent, findJourney } from "@/application/journey/journey-store";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { activateScenario } from "@/integrations/mock/mock-scenarios";
import { HASH_SECRET, runJob } from "./helpers/agent";
import { OIL, OWNER_C1, OWNER_C2, depsAt, driveToRecommendation } from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V, customers: C, workshops: W } = DEMO_IDS;
let seq = 0;

async function gatewayFor(owner = OWNER_C1, vehicleId: string = V.v1, minutes = 0) {
  const session = await db.conversationSession.create({ data: { vehicleId, actorId: owner.actorId, customerId: owner.customerId, serviceCode: OIL, memory: {}, promptVersion: "advisor-v1", model: "test" } });
  const ctx: AgentSessionContext = {
    sessionId: session.id,
    traceId: `trc-gw-${++seq}`,
    owner,
    agent: { actorId: "agent:maintenance-advisor", role: "SYSTEM_AGENT", customerId: owner.customerId, workshopId: null },
    vehicleId,
    serviceCode: OIL,
  };
  return { gateway: new ToolGateway({ ...depsAt(db, minutes), hashSecret: HASH_SECRET }, ctx), ctx };
}

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("GW — Tool Gateway", () => {
  it("GW-01 el modelo no puede elegir vehículo ni agregar campos: INVALID_INPUT", async () => {
    const { gateway } = await gatewayFor();
    expect(await gateway.execute("getVehicleProfile", { vehicleId: V.v2 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await gateway.execute("getQuote", { workshopId: W.t1, totalCop: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await gateway.execute("recordOdometer", { valueKm: "mucho" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("GW-02 herramienta no permitida en el estado → TOOL_NOT_ALLOWED_IN_STATE y queda registrada", async () => {
    const { gateway, ctx } = await gatewayFor();
    const r = await gateway.execute("prepareBooking", { quoteId: "q", slotRef: "slot-t1-2" });
    expect(r).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ALLOWED_IN_STATE", detail: "ACTIVATED" } });
    expect(await db.toolCall.findFirst({ where: { traceId: ctx.traceId } })).toMatchObject({ toolName: "prepareBooking", ok: false, errorCode: "TOOL_NOT_ALLOWED_IN_STATE", stateAtCall: "ACTIVATED" });
  });

  it("GW-03 sin titularidad vigente → UNAUTHORIZED (acceso cruzado)", async () => {
    await runJob(db);
    const { gateway } = await gatewayFor(OWNER_C2, V.v1);
    expect(await gateway.execute("getVehicleProfile", {})).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await gateway.execute("getServiceHistory", {})).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("GW-04 una mutación repetida en el mismo turno produce un solo efecto", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway } = await gatewayFor();
    const a = await gateway.execute("recordOdometer", { valueKm: 74_300 });
    const b = await gateway.execute("recordOdometer", { valueKm: 74_300 });
    expect(a).toMatchObject({ ok: true, data: { duplicate: false } });
    expect(b).toMatchObject({ ok: true, data: { duplicate: true } });
    expect(await db.odometerReading.count({ where: { vehicleId: V.v1, valueKm: 74_300 } })).toBe(1);
  });

  it("GW-05 createHumanCase(SAFETY_ESCALATION, NORMAL) se trata como señal de seguridad URGENT", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway, ctx } = await gatewayFor();
    const r = await gateway.execute("createHumanCase", { reason: "SAFETY_ESCALATION", priority: "NORMAL", summary: "El cliente reporta que el freno se hunde" });
    expect(r).toMatchObject({ ok: true, safetyEscalated: { caseId: expect.any(String) } });
    expect((await findJourney(db, ctx))!.state).toBe("SAFETY_ESCALATED");
    expect(await db.humanCase.findFirstOrThrow()).toMatchObject({ reason: "SAFETY_ESCALATION", priority: "URGENT" });
    // URGENT fuera de seguridad no se acepta.
    expect(await gateway.execute("createHumanCase", { reason: "CUSTOMER_REQUEST", priority: "URGENT", summary: "x" })).toMatchObject({ ok: false });
  });

  it("GW-06 un horario que no existe en el taller → SLOT_CONFLICT", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway } = await gatewayFor();
    const quote = await gateway.execute("getQuote", { workshopId: W.t1 });
    await gateway.execute("getAvailableSlots", { workshopId: W.t1 });
    const quoteId = quote.ok ? (quote.data.quoteId as string) : "";
    expect(await gateway.execute("prepareBooking", { quoteId, slotRef: "slot-t2-1" })).toMatchObject({ ok: false, error: { code: "SLOT_CONFLICT" } });
    expect(await gateway.execute("prepareBooking", { quoteId: "quote-de-otro", slotRef: "slot-t1-2" })).toMatchObject({ ok: false, error: { code: "QUOTE_MISMATCH" } });
  });

  it("GW-07 con una reserva activa no se prepara otra (ACTIVE_BOOKING_EXISTS)", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway } = await gatewayFor();
    const quote = await gateway.execute("getQuote", { workshopId: W.t1 });
    const quoteId = quote.ok ? (quote.data.quoteId as string) : "";
    await gateway.execute("getAvailableSlots", { workshopId: W.t1 });
    const prepared = await gateway.execute("prepareBooking", { quoteId, slotRef: "slot-t1-2" });
    const { confirmBooking } = await import("@/application/booking/confirm-booking");
    const confirmed = await confirmBooking(depsAt(db), { actor: OWNER_C1, confirmationToken: prepared.ok ? (prepared.data.confirmationToken as string) : "", traceId: "t" });
    expect(confirmed.ok).toBe(true);
    // En BOOKED la herramienta ni siquiera está permitida; la regla de negocio también lo impediría.
    expect(await gateway.execute("prepareBooking", { quoteId, slotRef: "slot-t1-3" })).toMatchObject({ ok: false, error: { code: "TOOL_NOT_ALLOWED_IN_STATE" } });
  });

  it("GW-08 una falla del taller se devuelve tipada, reintentable y sin detalles internos", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway } = await gatewayFor();
    await activateScenario(db, "WORKSHOP_DOWN");
    const r = await gateway.execute("getQuote", { workshopId: W.t1 });
    expect(r).toMatchObject({ ok: false, error: { code: "WORKSHOP_UNAVAILABLE", retryable: true, userSafeMessage: "El sistema del taller no responde en este momento." } });
    expect(JSON.stringify(r.forModel)).not.toMatch(/stack|Error:|prisma|SERVICIO_NO_DISPONIBLE/i);
  });

  it("GW-09 cada llamada queda en ToolCall con traceId, vehículo pseudonimizado, duración y fuente", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway, ctx } = await gatewayFor();
    await gateway.execute("evaluateMaintenance", {});
    await gateway.execute("getQuote", { workshopId: W.t1 });
    const calls = await db.toolCall.findMany({ where: { traceId: ctx.traceId }, orderBy: { createdAt: "asc" } });
    expect(calls.map((c) => [c.toolName, c.source, c.actorRole])).toEqual([
      ["evaluateMaintenance", "INTERNAL", "SYSTEM_AGENT"],
      ["getQuote", "MOCK", "SYSTEM_AGENT"],
    ]);
    for (const c of calls) {
      expect(c.vehicleIdHash).toMatch(/^[0-9a-f]{32}$/);
      expect(c.vehicleIdHash).not.toContain(V.v1);
      expect(c.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("GW-10 sin PII ni tokens en el registro ni en lo que recibe el modelo", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, { ...OWNER_C1, actorId: "agent", role: "SYSTEM_AGENT" });
    const { gateway, ctx } = await gatewayFor();
    const profile = await gateway.execute("getVehicleProfile", {});
    const quote = await gateway.execute("getQuote", { workshopId: W.t1 });
    await gateway.execute("getAvailableSlots", { workshopId: W.t1 });
    const prepared = await gateway.execute("prepareBooking", { quoteId: quote.ok ? (quote.data.quoteId as string) : "", slotRef: "slot-t1-2" });
    await gateway.execute("createHumanCase", { reason: "CUSTOMER_REQUEST", priority: "NORMAL", summary: "Mi correo es c1@demo.invalid y mi teléfono +57 000 000 0001" });
    const token = prepared.ok ? (prepared.data.confirmationToken as string) : "";
    expect(token.length).toBeGreaterThan(20);
    expect(prepared.forModel).not.toHaveProperty("confirmationToken");
    expect(JSON.stringify(profile.forModel)).not.toMatch(/DMO001|plate|@demo\.invalid|Cliente Demo/);
    const logged = JSON.stringify(await db.toolCall.findMany({ where: { traceId: ctx.traceId } }));
    for (const secret of [token, "c1@demo.invalid", "+57 000 000 0001", "DMO001", C.c1]) expect(logged).not.toContain(secret);
  });

  it("herramientas inexistentes (p. ej. confirmBooking) y exceso de llamadas se rechazan", async () => {
    const { gateway } = await gatewayFor();
    expect(await gateway.execute("confirmBooking", { confirmationToken: "x" })).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    expect(await gateway.execute("completeWorkOrder", {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    for (let i = 0; i < 6; i++) await gateway.execute("getVehicleProfile", {});
    expect(await gateway.execute("getVehicleProfile", {})).toMatchObject({ ok: false, error: { code: "TOOL_CALL_LIMIT" } });
  });

  it("sin consentimiento AI_ASSISTANT_PROCESSING el gateway no ejecuta herramientas", async () => {
    await db.consent.update({ where: { customerId_purpose_channel: { customerId: C.c1, purpose: "AI_ASSISTANT_PROCESSING", channel: "PORTAL" } }, data: { isGranted: false } });
    const { gateway } = await gatewayFor();
    expect(await gateway.execute("getVehicleProfile", {})).toMatchObject({ ok: false, error: { code: "CONSENT_REQUIRED" } });
  });

  it("el agente no puede emitir eventos de confirmación aunque llegue al journey por otra vía", async () => {
    await runJob(db);
    const r = await applyJourneyEvent(db, { vehicleId: V.v1, serviceCode: OIL, event: { type: "BOOKING_CONFIRMED", intentId: "i", bookingId: "b", externalBookingRef: "F" }, actor: { actorId: "agent", role: "SYSTEM_AGENT" }, traceId: "t", idempotencyKey: "x" });
    expect(r).toMatchObject({ ok: false, error: { code: "ACTOR_NOT_PERMITTED" } });
  });
});
