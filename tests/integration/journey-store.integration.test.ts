import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyJourneyEvent,
  findJourney,
  verifyJourneyConsistency,
  type ApplyEventCommand,
} from "@/application/journey/journey-store";
import type { JourneyEvent } from "@/domain/journey";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { expectDbRejection } from "./helpers/assertions";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V, actors: A } = DEMO_IDS;
const KEY = { vehicleId: V.v1, serviceCode: "ENGINE_OIL_FILTER" };
const JOB = { actorId: A.systemJob, role: "SYSTEM_JOB" as const };
const ADVISOR = { actorId: A.advisor, role: "ADVISOR" as const };

const evaluated = (evaluationId: string, status: "UPCOMING" | "NOT_DUE" = "UPCOMING"): JourneyEvent => ({
  type: "EVALUATED",
  evaluationId,
  status,
  reasons: [],
  requiresOdometerConfirmation: false,
  cycleKey: "cycle-1",
});
const cmd = (event: JourneyEvent, idempotencyKey: string, overrides: Partial<ApplyEventCommand> = {}): ApplyEventCommand => ({
  ...KEY,
  event,
  actor: JOB,
  traceId: "trc-js",
  idempotencyKey,
  ...overrides,
});

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("journey-store — persistencia atómica", () => {
  it("aplica un evento: estado, versión, contexto y JourneyEvent en la misma transacción", async () => {
    const r = await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    expect(r).toMatchObject({ ok: true, value: { status: "APPLIED", from: "ACTIVATED", to: "NEED_DETECTED", seq: 1, version: 1 } });

    const journey = await db.journeyInstance.findFirstOrThrow({ where: KEY, include: { events: true } });
    expect(journey).toMatchObject({ state: "NEED_DETECTED", version: 1, useCase: "UC-01" });
    expect(journey.context).toMatchObject({ lastEvaluation: { evaluationId: "ev-1", status: "UPCOMING" } });
    expect(journey.events).toHaveLength(1);
    expect(journey.events[0]).toMatchObject({ seq: 1, type: "EVALUATED", fromState: "ACTIVATED", toState: "NEED_DETECTED", actorId: A.systemJob, actorRole: "SYSTEM_JOB", idempotencyKey: "k-1" });
    expect(journey.events[0].payload).toMatchObject({ evaluationId: "ev-1", status: "UPCOMING" });
  });

  it("una transición inválida no escribe nada y devuelve un error tipado", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const r = await applyJourneyEvent(db, cmd({ type: "BOOKING_CONFIRMED", intentId: "i", bookingId: "b", externalBookingRef: "VC-1" }, "k-2", { actor: { actorId: A.ownerC1, role: "OWNER" } }));
    expect(r).toEqual({ ok: false, error: { code: "INVALID_TRANSITION", state: "NEED_DETECTED", event: "BOOKING_CONFIRMED" } });
    expect(await findJourney(db, KEY)).toMatchObject({ state: "NEED_DETECTED", version: 1 });
    expect(await db.journeyEvent.count()).toBe(1);
  });

  it("un actor no autorizado por la FSM se rechaza sin escribir", async () => {
    const r = await applyJourneyEvent(db, cmd({ type: "CONTACT_SENT", outboundMessageId: "m", dedupKey: "d" }, "k-x", { actor: ADVISOR }));
    expect(r).toMatchObject({ ok: false, error: { code: "ACTOR_NOT_PERMITTED" } });
    expect(await db.journeyInstance.count()).toBe(0);
  });

  it("el estado persistido es consistente con la reproducción de sus eventos", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    await applyJourneyEvent(db, cmd({ type: "OWNER_OPENED" }, "k-2", { actor: { actorId: A.ownerC1, role: "OWNER" } }));
    await applyJourneyEvent(db, cmd({ type: "SAFETY_SIGNAL", caseId: "case-x", source: "STAFF" }, "k-3", { actor: ADVISOR }));
    const journey = (await findJourney(db, KEY))!;
    expect(await verifyJourneyConsistency(db, journey.id)).toEqual({ ok: true, value: "SAFETY_ESCALATED" });
  });

  it("detecta una manipulación directa del estado que no pasó por la FSM", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const journey = (await findJourney(db, KEY))!;
    await db.journeyInstance.update({ where: { id: journey.id }, data: { state: "BOOKED" } });
    const check = await verifyJourneyConsistency(db, journey.id);
    expect(check).toMatchObject({ ok: false, error: [{ kind: "FINAL_STATE_MISMATCH", expected: "NEED_DETECTED", found: "BOOKED" }] });
  });

  it("solo se aceptan eventos de negocio: un tipo conversacional es rechazado por la base", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const journey = (await findJourney(db, KEY))!;
    await expectDbRejection(
      db.journeyEvent.create({
        data: { journeyId: journey.id, seq: 2, type: "USER_MESSAGE", fromState: "NEED_DETECTED", toState: "NEED_DETECTED", payload: { text: "hola" }, actorId: "x", actorRole: "OWNER", traceId: "t", idempotencyKey: "k-msg" },
      }),
      /JourneyEvent_business_event_type/,
    );
  });
});

describe("journey-store — idempotencia (reintentos)", () => {
  it("reintentar con la misma clave devuelve DUPLICATE y no crea otro evento", async () => {
    const first = await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const retry = await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    expect(first).toMatchObject({ ok: true, value: { status: "APPLIED", seq: 1 } });
    expect(retry).toMatchObject({ ok: true, value: { status: "DUPLICATE", seq: 1, to: "NEED_DETECTED" } });
    expect(await db.journeyEvent.count()).toBe(1);
    expect(await findJourney(db, KEY)).toMatchObject({ version: 1 });
  });

  it("la misma clave usada para otra operación → IDEMPOTENCY_MISMATCH", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const r = await applyJourneyEvent(db, cmd({ type: "SAFETY_SIGNAL", caseId: "c", source: "STAFF" }, "k-1", { actor: ADVISOR }));
    expect(r).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_MISMATCH", idempotencyKey: "k-1" } });
  });
});

describe("journey-store — concurrencia y bloqueo optimista", () => {
  it("expectedVersion desactualizada → VERSION_CONFLICT sin escribir", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const r = await applyJourneyEvent(db, cmd({ type: "OWNER_OPENED" }, "k-2", { actor: { actorId: A.ownerC1, role: "OWNER" }, expectedVersion: 0 }));
    expect(r).toEqual({ ok: false, error: { code: "VERSION_CONFLICT", expected: 0, actual: 1, retryable: false } });
    expect(await findJourney(db, KEY)).toMatchObject({ state: "NEED_DETECTED", version: 1 });
  });

  it("dos usuarios con la misma versión: uno gana y el otro recibe VERSION_CONFLICT", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-1"));
    const owner = { actorId: A.ownerC1, role: "OWNER" as const };
    const results = await Promise.all([
      applyJourneyEvent(db, cmd({ type: "OWNER_OPENED" }, "k-open", { actor: owner, expectedVersion: 1 })),
      applyJourneyEvent(db, cmd({ type: "SAFETY_SIGNAL", caseId: "c", source: "STAFF" }, "k-safe", { actor: ADVISOR, expectedVersion: 1 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error.code)).toEqual(["VERSION_CONFLICT"]);
    const journey = (await findJourney(db, KEY))!;
    expect(journey.version).toBe(2);
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
  });

  it("eventos concurrentes sin versión esperada se serializan: secuencia 1..N sin huecos ni duplicados", async () => {
    await applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-0"));
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => applyJourneyEvent(db, cmd({ type: "CONTACT_SENT", outboundMessageId: `m-${i}`, dedupKey: `d-${i}` }, `k-c-${i}`))),
    );
    expect(results.every((r) => r.ok && r.value.status === "APPLIED")).toBe(true);
    const journey = (await findJourney(db, KEY))!;
    const seqs = (await db.journeyEvent.findMany({ where: { journeyId: journey.id }, orderBy: { seq: "asc" } })).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: N + 1 }, (_, i) => i + 1));
    expect(journey.version).toBe(N + 1);
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
  });

  it("el mismo reintento lanzado en paralelo produce un único evento", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => applyJourneyEvent(db, cmd(evaluated("ev-1"), "k-same"))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.status === "APPLIED")).toHaveLength(1);
    expect(await db.journeyEvent.count()).toBe(1);
    expect(await db.journeyInstance.count()).toBe(1);
  });
});
