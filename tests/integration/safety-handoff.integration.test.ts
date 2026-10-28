import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getVehicleProfile } from "@/application/get-vehicle-profile";
import { applyJourneyEvent, findJourney, verifyJourneyConsistency } from "@/application/journey/journey-store";
import { reportSafetySignal } from "@/application/report-safety-signal";
import { resolveHumanCase } from "@/application/resolve-human-case";
import { runEvaluationJob } from "@/application/run-evaluation-job";
import { allowedTools, COMMERCIAL_TOOLS, type JourneyEvent } from "@/domain/journey";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import type { ActorContext } from "@/domain/policies/access-policy";
import { fixedClock } from "@/infra/clock";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { MockNotificationPort } from "@/integrations/mock/mock-notifications";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const clock = fixedClock(DEMO_NOW.toISOString());
const deps = { db, clock };
const { vehicles: V, customers: C, actors: A, workshops: W } = DEMO_IDS;
const OIL = "ENGINE_OIL_FILTER";
const KEY = { vehicleId: V.v1, serviceCode: OIL };

const actor = (actorId: string, role: ActorContext["role"], customerId: string | null = null): ActorContext => ({ actorId, role, customerId, workshopId: null });
const ADVISOR = actor(A.advisor, "ADVISOR");
const COMPLIANCE = actor(A.compliance, "COMPLIANCE");
const OWNER_C1 = actor(A.ownerC1, "OWNER", C.c1);
const AGENT_FOR_C1 = actor("agent", "SYSTEM_AGENT", C.c1);
const j = (a: ActorContext) => ({ actorId: a.actorId, role: a.role });

async function apply(event: JourneyEvent, by: ActorContext, key: string) {
  const r = await applyJourneyEvent(db, { ...KEY, event, actor: j(by), traceId: "trc-sh", idempotencyKey: key });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Lleva V1 hasta AWAITING_CONFIRMATION con cotización e intención reales. */
async function driveToAwaitingConfirmation(): Promise<{ intentId: string }> {
  await runEvaluationJob({ db, clock, notifications: new MockNotificationPort() }, { actor: actor(A.systemJob, "SYSTEM_JOB"), traceId: "trc-job" });
  const journey = (await findJourney(db, KEY))!;
  await apply({ type: "OWNER_OPENED" }, OWNER_C1, "open");
  await apply({ type: "RECOMMENDATION_SHOWN", evaluationId: journey.context.lastEvaluation!.evaluationId }, AGENT_FOR_C1, "reco");
  const quote = await db.quote.create({
    data: { vehicleId: V.v1, workshopId: W.t1, serviceCode: OIL, status: "ACTIVE", isEstimate: false, totalCop: 1, validUntil: new Date("2026-10-29T00:00:00Z"), source: "MOCK", traceId: "trc" },
  });
  await apply({ type: "QUOTE_ISSUED", quoteId: quote.id }, AGENT_FOR_C1, "quote");
  await apply({ type: "SLOTS_LISTED", workshopId: W.t1 }, AGENT_FOR_C1, "slots");
  const intent = await db.bookingIntent.create({
    data: { confirmationTokenHash: "a".repeat(64), customerId: C.c1, serviceCode: OIL, vehicleId: V.v1, quoteId: quote.id, slotExternalRef: "slot-t1-2", slotStartsAt: new Date("2026-10-30T13:00:00Z"), workshopId: W.t1, requestedById: A.ownerC1, expiresAt: new Date("2026-10-28T18:00:00Z"), traceId: "trc" },
  });
  await apply({ type: "BOOKING_INTENT_CREATED", intentId: intent.id }, AGENT_FOR_C1, "intent");
  return { intentId: intent.id };
}

const signal = (by: ActorContext, idempotencyKey: string, vehicleId: string = V.v1) =>
  reportSafetySignal(deps, { actor: by, vehicleId, serviceCode: OIL, source: "SAFETY_LEXICON", summary: "Síntoma de frenos (texto sintético)", traceId: "trc-s", idempotencyKey });

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Transición de seguridad (EX-02)", () => {
  it("interrumpe el journey, crea caso URGENT asignado, invalida la intención pendiente y conserva el actor", async () => {
    const { intentId } = await driveToAwaitingConfirmation();
    const r = await signal(AGENT_FOR_C1, "s-1");
    expect(r).toMatchObject({ ok: true, value: { journeyState: "SAFETY_ESCALATED", status: "APPLIED", invalidatedIntentIds: [intentId] } });
    if (!r.ok) return;

    expect(await db.bookingIntent.findUniqueOrThrow({ where: { id: intentId } })).toMatchObject({ status: "REJECTED" });
    const kase = await db.humanCase.findUniqueOrThrow({ where: { id: r.value.caseId } });
    expect(kase).toMatchObject({ reason: "SAFETY_ESCALATION", priority: "URGENT", status: "ASSIGNED", assigneeId: A.advisor, openedById: "agent" });
    const journey = (await findJourney(db, KEY))!;
    expect(journey.context).toMatchObject({ openCaseId: r.value.caseId, pendingIntentId: null });
    const last = await db.journeyEvent.findFirstOrThrow({ where: { journeyId: journey.id }, orderBy: { seq: "desc" } });
    expect(last).toMatchObject({ type: "SAFETY_SIGNAL", actorId: "agent", actorRole: "SYSTEM_AGENT", fromState: "AWAITING_CONFIRMATION" });
    expect(last.payload).not.toHaveProperty("summary"); // el texto vive en el caso, no en el evento
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
  });

  it("en SAFETY_ESCALATED se bloquean las acciones comerciales", async () => {
    const { intentId } = await driveToAwaitingConfirmation();
    await signal(AGENT_FOR_C1, "s-1");
    const confirm = await applyJourneyEvent(db, { ...KEY, event: { type: "BOOKING_CONFIRMED", intentId, bookingId: "b", externalBookingRef: "VC-1" }, actor: j(OWNER_C1), traceId: "t", idempotencyKey: "confirm" });
    expect(confirm).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION", state: "SAFETY_ESCALATED" } });
    const slots = await applyJourneyEvent(db, { ...KEY, event: { type: "SLOTS_LISTED", workshopId: W.t1 }, actor: j(AGENT_FOR_C1), traceId: "t", idempotencyKey: "slots-2" });
    expect(slots.ok).toBe(false);
    expect(allowedTools("SAFETY_ESCALATED").some((t) => COMMERCIAL_TOOLS.has(t))).toBe(false);
  });

  it("la señal es idempotente: un reintento no crea otro caso ni otro evento", async () => {
    await driveToAwaitingConfirmation();
    const first = await signal(AGENT_FOR_C1, "s-1");
    const retry = await signal(AGENT_FOR_C1, "s-1");
    expect(retry).toMatchObject({ ok: true, value: { status: "DUPLICATE" } });
    if (first.ok && retry.ok) expect(retry.value.caseId).toBe(first.value.caseId);
    expect(await db.humanCase.count()).toBe(1);
    expect(await db.journeyEvent.count({ where: { type: "SAFETY_SIGNAL" } })).toBe(1);
  });

  it("sobre un journey cerrado la señal se rechaza y no deja un caso huérfano", async () => {
    await driveToAwaitingConfirmation();
    const s = await signal(AGENT_FOR_C1, "s-1");
    if (!s.ok) throw new Error("señal fallida");
    await resolveHumanCase(deps, { actor: ADVISOR, caseId: s.value.caseId, outcome: "CLOSE", resolution: "Atendido por asistencia (sintético)", traceId: "t", idempotencyKey: "r-1" });
    const again = await signal(AGENT_FOR_C1, "s-2");
    expect(again).toMatchObject({ ok: false, error: { code: "TERMINAL_STATE" } });
    expect(await db.humanCase.count()).toBe(1);
  });

  it("quien no tiene acceso al vehículo no puede emitir la señal", async () => {
    expect(await signal(actor(A.ownerC2, "OWNER", C.c2), "s-x")).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await db.humanCase.count()).toBe(0);
  });
});

describe("Resolución humana (solo rol autorizado y asignado)", () => {
  async function escalated() {
    await driveToAwaitingConfirmation();
    const s = await signal(AGENT_FOR_C1, "s-1");
    if (!s.ok) throw new Error("señal fallida");
    return s.value.caseId;
  }
  const resolve = (by: ActorContext, caseId: string, key: string, outcome: "CLEARED_FOR_SERVICE" | "CLOSE" = "CLEARED_FOR_SERVICE") =>
    resolveHumanCase(deps, { actor: by, caseId, outcome, resolution: "Revisado por asesor; apto para agendar (sintético)", traceId: "trc-r", idempotencyKey: key });

  it("ni el agente, ni el propietario, ni un humano no asignado pueden resolver", async () => {
    const caseId = await escalated();
    expect(await resolve(AGENT_FOR_C1, caseId, "r-a")).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", detail: "ROLE_NOT_PERMITTED" } });
    expect(await resolve(OWNER_C1, caseId, "r-o")).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", detail: "ROLE_NOT_PERMITTED" } });
    expect(await resolve(COMPLIANCE, caseId, "r-c")).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", detail: "NOT_ASSIGNED" } });
    expect((await findJourney(db, KEY))!.state).toBe("SAFETY_ESCALATED");
  });

  it("el asesor asignado habilita la salida: caso resuelto, evento con su identidad y AuditLog", async () => {
    const caseId = await escalated();
    const r = await resolve(ADVISOR, caseId, "r-1");
    expect(r).toMatchObject({ ok: true, value: { journeyState: "CONVERSATION_OPEN", status: "APPLIED" } });

    expect(await db.humanCase.findUniqueOrThrow({ where: { id: caseId } })).toMatchObject({ status: "RESOLVED", resolution: expect.stringContaining("apto") });
    const journey = (await findJourney(db, KEY))!;
    const last = await db.journeyEvent.findFirstOrThrow({ where: { journeyId: journey.id }, orderBy: { seq: "desc" } });
    expect(last).toMatchObject({ type: "CASE_RESOLVED_BY_HUMAN", actorId: A.advisor, actorRole: "ADVISOR", fromState: "SAFETY_ESCALATED", toState: "CONVERSATION_OPEN" });
    expect(await db.auditLog.findFirst({ where: { entityId: caseId, action: "CASE_RESOLVED" } })).toMatchObject({ actorId: A.advisor });

    // Todos los eventos se conservan: el historial reproduce el estado actual.
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
    expect(await db.journeyEvent.count({ where: { journeyId: journey.id, type: "SAFETY_SIGNAL" } })).toBe(1);
  });

  it("reintentar la resolución es idempotente; una nueva resolución sobre un caso cerrado se rechaza", async () => {
    const caseId = await escalated();
    await resolve(ADVISOR, caseId, "r-1");
    expect(await resolve(ADVISOR, caseId, "r-1")).toMatchObject({ ok: true, value: { status: "DUPLICATE" } });
    expect(await resolve(ADVISOR, caseId, "r-2")).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", detail: "CASE_NOT_OPEN" } });
    expect(await db.auditLog.count({ where: { entityId: caseId } })).toBe(1);
  });

  it("la intención invalidada no puede confirmarse después del alta de seguridad", async () => {
    const caseId = await escalated();
    await resolve(ADVISOR, caseId, "r-1");
    const intent = await db.bookingIntent.findFirstOrThrow();
    const r = await applyJourneyEvent(db, { ...KEY, event: { type: "BOOKING_CONFIRMED", intentId: intent.id, bookingId: "b", externalBookingRef: "VC-1" }, actor: j(OWNER_C1), traceId: "t", idempotencyKey: "late-confirm" });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION", state: "CONVERSATION_OPEN" } });
  });
});

describe("Mínimo privilegio para personal (ADR-016)", () => {
  it("el asesor accede solo a su cartera (C1, C2), no a C3", async () => {
    expect((await getVehicleProfile(deps, { actor: ADVISOR, vehicleId: V.v1 })).ok).toBe(true);
    expect((await getVehicleProfile(deps, { actor: ADVISOR, vehicleId: V.v2 })).ok).toBe(true);
    expect(await getVehicleProfile(deps, { actor: ADVISOR, vehicleId: V.v3 })).toEqual({ ok: false, error: { code: "UNAUTHORIZED", detail: "NOT_ASSIGNED" } });
  });

  it("compliance no tiene acceso operativo a perfiles", async () => {
    expect(await getVehicleProfile(deps, { actor: COMPLIANCE, vehicleId: V.v1 })).toEqual({ ok: false, error: { code: "UNAUTHORIZED", detail: "ROLE_NOT_PERMITTED" } });
  });

  it("un caso asignado concede acceso temporal; al resolverse, se retira", async () => {
    const kase = await db.humanCase.create({
      data: { vehicleId: V.v3, reason: "CUSTOMER_REQUEST", priority: "NORMAL", status: "ASSIGNED", assigneeRole: "ADVISOR", assigneeId: A.advisor, minimalContext: {}, slaDueAt: new Date("2026-10-29T00:00:00Z"), idempotencyKey: "case-v3", openedById: A.ownerC3, traceId: "t" },
    });
    expect((await getVehicleProfile(deps, { actor: ADVISOR, vehicleId: V.v3 })).ok).toBe(true);
    await db.humanCase.update({ where: { id: kase.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    expect((await getVehicleProfile(deps, { actor: ADVISOR, vehicleId: V.v3 })).ok).toBe(false);
  });

  it("sin cartera, el caso de seguridad queda OPEN sin asignar y nadie puede resolverlo hasta su asignación", async () => {
    const owner = actor(A.ownerC3, "OWNER", C.c3);
    const r = await signal(owner, "s-v3", V.v3);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(await db.humanCase.findUniqueOrThrow({ where: { id: r.value.caseId } })).toMatchObject({ status: "OPEN", assigneeId: null });
    expect(await resolveHumanCase(deps, { actor: ADVISOR, caseId: r.value.caseId, outcome: "CLOSE", resolution: "x", traceId: "t", idempotencyKey: "r-v3" })).toMatchObject({
      ok: false,
      error: { detail: "NOT_ASSIGNED" },
    });
  });
});
