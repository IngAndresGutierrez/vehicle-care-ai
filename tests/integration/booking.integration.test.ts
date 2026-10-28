import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BookingDeps } from "@/application/booking/common";
import { confirmBooking, reconcileBooking, MAX_RECONCILIATION_ATTEMPTS } from "@/application/booking/confirm-booking";
import { prepareBooking } from "@/application/booking/prepare-booking";
import { getAvailableSlots, listWorkshops, requestQuote } from "@/application/booking/quotes-and-slots";
import { findJourney, verifyJourneyConsistency } from "@/application/journey/journey-store";
import { reportSafetySignal } from "@/application/report-safety-signal";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { hashToken } from "@/infra/tokens";
import { activateScenario } from "@/integrations/mock/mock-scenarios";
import type { WorkshopPort } from "@/integrations/ports/workshop";
import {
  ADVISOR,
  AGENT_C1,
  AGENT_C2,
  OIL,
  OWNER_C1,
  OWNER_C2,
  OWNER_C3,
  actor,
  depsAt,
  driveToRecommendation,
  must,
} from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V, workshops: W, customers: C } = DEMO_IDS;
const KEY_V1 = { vehicleId: V.v1, serviceCode: OIL };

let seq = 0;
const k = (p: string) => `${p}-${++seq}`;

async function quoteFor(deps: BookingDeps, vehicleId = V.v1, agent = AGENT_C1, workshopId: string = W.t1) {
  return requestQuote(deps, { actor: agent, vehicleId, serviceCode: OIL, workshopId, traceId: "trc-q", idempotencyKey: k("q") });
}
async function slotsFor(deps: BookingDeps, vehicleId = V.v1, agent = AGENT_C1, workshopId: string = W.t1) {
  return getAvailableSlots(deps, { actor: agent, vehicleId, serviceCode: OIL, workshopId, traceId: "trc-s", idempotencyKey: k("s") });
}
/** Recorrido completo hasta AWAITING_CONFIRMATION; devuelve la intención preparada. */
async function prepareFor(opts: { vehicleId?: string; owner?: typeof OWNER_C1; agent?: typeof AGENT_C1; slotRef?: string; deps?: BookingDeps } = {}) {
  const vehicleId = opts.vehicleId ?? V.v1;
  const agent = opts.agent ?? AGENT_C1;
  const deps = opts.deps ?? depsAt(db);
  await driveToRecommendation(db, vehicleId, opts.owner ?? OWNER_C1, agent);
  const quote = must(await quoteFor(deps, vehicleId, agent));
  const slots = must(await slotsFor(deps, vehicleId, agent));
  const slotRef = opts.slotRef ?? slots.slots[0].slotRef;
  const prepared = must(await prepareBooking(deps, { actor: agent, vehicleId, serviceCode: OIL, quoteId: quote.quoteId, slotRef, traceId: "trc-p", idempotencyKey: k("p") }));
  return { quote, slots, prepared };
}
const confirm = (token: string, by = OWNER_C1, deps = depsAt(db)) => confirmBooking(deps, { actor: by, confirmationToken: token, traceId: "trc-c" });
const slotRemaining = async (id: string) => (await db.mockSlot.findUniqueOrThrow({ where: { id } })).remaining;

beforeEach(async () => {
  await resetAndSeed(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Flujo completo: cotización → horarios → intención → confirmación → reserva", () => {
  it("IT-07 + IT-10: reserva confirmada con folio del taller MOCK y cupo descontado", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    const deps = depsAt(db);

    expect(must(await listWorkshops(deps, { actor: OWNER_C1, vehicleId: V.v1, serviceCode: OIL })).map((w) => w.name)).toEqual(["Taller Norte (demo)", "Taller Sur (demo)"]);

    const quote = must(await quoteFor(deps));
    expect(quote).toMatchObject({ subtotalCop: 280_000, taxCop: 53_200, totalCop: 333_200, source: "MOCK", journeyState: "QUOTE_PRESENTED", catalogVersion: expect.stringMatching(/^SYNTHETIC-DEMO:/) });
    expect(await db.quote.findUniqueOrThrow({ where: { id: quote.quoteId } })).toMatchObject({ status: "ACTIVE", source: "MOCK", totalCop: 333_200 });

    const slots = must(await slotsFor(deps));
    expect(slots).toMatchObject({ source: "MOCK", journeyState: "SLOT_SELECTION" });
    const slotRef = slots.slots[0].slotRef;
    const before = await slotRemaining(slotRef);

    const prepared = must(await prepareBooking(deps, { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, quoteId: quote.quoteId, slotRef, traceId: "trc-p", idempotencyKey: "prep-1" }));
    expect(prepared).toMatchObject({ requiresUserConfirmation: true, reissued: false, summary: { totalCop: 333_200, source: "MOCK" } });
    expect((await findJourney(db, KEY_V1))!.state).toBe("AWAITING_CONFIRMATION");
    expect(await slotRemaining(slotRef)).toBe(before); // preparar no reserva

    const confirmed = must(await confirm(prepared.confirmationToken));
    expect(confirmed).toMatchObject({ status: "CONFIRMED", folio: expect.stringMatching(/^FOLIO-T1-DEMO-/), source: "MOCK", duplicate: false });
    expect(await slotRemaining(slotRef)).toBe(before - 1);

    const booking = await db.booking.findFirstOrThrow({ where: { vehicleId: V.v1 } });
    expect(booking).toMatchObject({ status: "CONFIRMED", externalBookingRef: confirmed.status === "CONFIRMED" ? confirmed.folio : "", confirmedById: OWNER_C1.actorId, confirmedByRole: "OWNER", source: "MOCK" });
    const journey = (await findJourney(db, KEY_V1))!;
    expect(journey).toMatchObject({ state: "BOOKED", context: { activeBookingId: booking.id, pendingIntentId: null } });
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
    expect(await db.mockCrmInteraction.count({ where: { kind: "BOOKING_CONFIRMED" } })).toBe(1);
  });

  it("consistencia Booking ↔ taller MOCK ↔ JourneyEvent tras la confirmación", async () => {
    const { prepared } = await prepareFor();
    const confirmed = must(await confirm(prepared.confirmationToken));
    if (confirmed.status !== "CONFIRMED") throw new Error("no confirmada");
    const booking = await db.booking.findFirstOrThrow({ where: { vehicleId: V.v1 } });
    const mock = await db.mockBooking.findUniqueOrThrow({ where: { idempotencyKey: booking.idempotencyKey } });
    expect(mock).toMatchObject({ folio: booking.externalBookingRef, slotId: booking.slotExternalRef, status: "CONFIRMED", vehicleRef: V.v1 });
    const event = await db.journeyEvent.findFirstOrThrow({ where: { type: "BOOKING_CONFIRMED" } });
    expect(event).toMatchObject({ actorId: OWNER_C1.actorId, actorRole: "OWNER", toState: "BOOKED" });
    expect(event.payload).toMatchObject({ bookingId: booking.id, externalBookingRef: booking.externalBookingRef, intentId: booking.intentId });
    expect(await db.bookingIntent.findUniqueOrThrow({ where: { id: booking.intentId } })).toMatchObject({ status: "CONSUMED" });
  });
});

describe("Cotizaciones y cupos (IT-07…IT-09)", () => {
  it("IT-08: catálogo sin precio → Quote UNAVAILABLE sin montos, caso humano y QUOTE_PENDING_HUMAN", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    await activateScenario(db, "QUOTE_UNAVAILABLE");
    const r = await quoteFor(depsAt(db));
    expect(r).toMatchObject({ ok: false, error: { code: "QUOTE_UNAVAILABLE", refs: { caseId: expect.any(String), quoteId: expect.any(String) } } });
    if (r.ok) return;
    expect(await db.quote.findUniqueOrThrow({ where: { id: r.error.refs!.quoteId } })).toMatchObject({ status: "UNAVAILABLE", totalCop: null, subtotalCop: null, source: "MOCK" });
    expect(await db.humanCase.findUniqueOrThrow({ where: { id: r.error.refs!.caseId } })).toMatchObject({ reason: "QUOTE_UNAVAILABLE", assigneeId: DEMO_IDS.actors.advisor });
    expect((await findJourney(db, KEY_V1))!.state).toBe("QUOTE_PENDING_HUMAN");
  });

  it("IT-09: sin cupos en el rango → NO_SLOTS y el journey no avanza", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    const deps = depsAt(db);
    must(await quoteFor(deps, V.v1, AGENT_C1, W.t2));
    await db.mockSlot.updateMany({ where: { workshopExternalRef: "T2-DEMO" }, data: { remaining: 0 } });
    expect(await slotsFor(deps, V.v1, AGENT_C1, W.t2)).toMatchObject({ ok: false, error: { code: "NO_SLOTS", detail: "SIN_CUPOS" } });
    expect((await findJourney(db, KEY_V1))!.state).toBe("QUOTE_PRESENTED");
  });

  it("taller caído al cotizar → WORKSHOP_UNAVAILABLE reintentable, sin escribir nada", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    await activateScenario(db, "WORKSHOP_DOWN");
    expect(await quoteFor(depsAt(db))).toMatchObject({ ok: false, error: { code: "WORKSHOP_UNAVAILABLE", retryable: true, detail: "SERVICIO_NO_DISPONIBLE" } });
    expect(await db.quote.count()).toBe(0);
    expect((await findJourney(db, KEY_V1))!.state).toBe("RECOMMENDATION_PRESENTED");
  });

  it("re-solicitar con la misma clave devuelve la misma cotización sin llamar al taller", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    const deps = depsAt(db);
    const args = { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, workshopId: W.t1, traceId: "t", idempotencyKey: "same-q" };
    const a = must(await requestQuote(deps, args));
    await activateScenario(db, "WORKSHOP_DOWN", null);
    const b = must(await requestQuote(deps, args));
    expect(b).toMatchObject({ quoteId: a.quoteId, duplicate: true });
    expect(await db.mockQuote.count()).toBe(1);
  });
});

describe("Concurrencia e idempotencia (IT-11…IT-13)", () => {
  it("IT-11: dos clientes confirman a la vez el último cupo → 1 CONFIRMED y 1 FAILED(SLOT_CONFLICT)", async () => {
    const lastSlot = "slot-t1-1"; // capacidad 1
    const a = await prepareFor({ slotRef: lastSlot });
    const b = await prepareFor({ vehicleId: V.v2, owner: OWNER_C2, agent: AGENT_C2, slotRef: lastSlot });

    const [ra, rb] = await Promise.all([confirm(a.prepared.confirmationToken, OWNER_C1), confirm(b.prepared.confirmationToken, OWNER_C2)]);
    const results = [ra, rb];
    expect(results.filter((r) => r.ok && r.value.status === "CONFIRMED")).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error.code)).toEqual(["SLOT_CONFLICT"]);
    expect(await slotRemaining(lastSlot)).toBe(0);
    expect(await db.mockBooking.count()).toBe(1);
    expect((await db.booking.findMany()).map((b) => b.status).sort()).toEqual(["CONFIRMED", "FAILED"]);

    // El perdedor vuelve a SLOT_SELECTION; ambos journeys son consistentes.
    const states = await Promise.all([V.v1, V.v2].map((vehicleId) => findJourney(db, { vehicleId, serviceCode: OIL })));
    expect(states.map((j) => j!.state).sort()).toEqual(["BOOKED", "SLOT_SELECTION"]);
    for (const j of states) expect((await verifyJourneyConsistency(db, j!.id)).ok).toBe(true);
  });

  it("IT-12: confirmación duplicada (doble clic en paralelo y reintento) → una sola reserva", async () => {
    const { prepared } = await prepareFor();
    const parallel = await Promise.all([confirm(prepared.confirmationToken), confirm(prepared.confirmationToken), confirm(prepared.confirmationToken)]);
    expect(parallel.every((r) => r.ok)).toBe(true);
    const retry = must(await confirm(prepared.confirmationToken));
    expect(retry).toMatchObject({ status: "CONFIRMED", duplicate: true });

    expect(await db.booking.count()).toBe(1);
    expect(await db.mockBooking.count()).toBe(1);
    expect(await db.journeyEvent.count({ where: { type: "BOOKING_CONFIRMED" } })).toBe(1);
    const folios = new Set(parallel.concat([{ ok: true, value: retry }]).flatMap((r) => (r.ok && r.value.status === "CONFIRMED" ? [r.value.folio] : [])));
    expect(folios.size).toBe(1);
  });

  it("IT-13: el taller rechaza la misma clave de idempotencia con contenido distinto", async () => {
    const deps = depsAt(db);
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    const quote = must(await quoteFor(deps));
    const ref = (await db.quote.findUniqueOrThrow({ where: { id: quote.quoteId } })).externalQuoteRef!;
    const req = { workshopRef: "T1-DEMO", externalQuoteRef: ref, customerRef: C.c1, vehicleRef: V.v1 };
    const first = await deps.workshop.createBooking({ ...req, slotRef: "slot-t1-2" }, "idem-x");
    const second = await deps.workshop.createBooking({ ...req, slotRef: "slot-t1-3" }, "idem-x");
    expect(first).toMatchObject({ ok: true, source: "MOCK" });
    expect(second).toEqual({ ok: false, source: "MOCK", error: { code: "IDEMPOTENCY_MISMATCH", retryable: false, raw: "CLAVE_REUTILIZADA" } });
  });

  it("ACTIVE_BOOKING_EXISTS: con una reserva activa no se prepara otra", async () => {
    const { quote, slots, prepared } = await prepareFor();
    must(await confirm(prepared.confirmationToken));
    const r = await prepareBooking(depsAt(db), { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, quoteId: quote.quoteId, slotRef: slots.slots[1].slotRef, traceId: "t", idempotencyKey: "p-2" });
    expect(r).toMatchObject({ ok: false, error: { code: "ACTIVE_BOOKING_EXISTS", refs: { bookingId: expect.any(String) } } });
  });
});

describe("Tokens de confirmación", () => {
  it("el token nunca se persiste en claro ni aparece en auditoría o eventos", async () => {
    const { prepared } = await prepareFor();
    const intent = await db.bookingIntent.findUniqueOrThrow({ where: { id: prepared.intentId } });
    expect(intent.confirmationTokenHash).toBe(hashToken(prepared.confirmationToken));
    expect(intent.confirmationTokenHash).not.toContain(prepared.confirmationToken);
    must(await confirm(prepared.confirmationToken));
    const dump = JSON.stringify([await db.auditLog.findMany(), await db.journeyEvent.findMany(), await db.booking.findMany(), await db.mockBooking.findMany(), await db.mockCrmInteraction.findMany()]);
    expect(dump).not.toContain(prepared.confirmationToken);
  });

  it("token inexistente o manipulado → INVALID_TOKEN", async () => {
    const { prepared } = await prepareFor();
    expect(await confirm("x".repeat(43))).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
    expect(await confirm(prepared.confirmationToken.slice(0, -1) + (prepared.confirmationToken.endsWith("A") ? "B" : "A"))).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN" } });
    expect(await confirm("")).toMatchObject({ ok: false, error: { code: "INVALID_TOKEN" } });
  });

  it("token expirado → INTENT_EXPIRED, intención EXPIRED y journey de vuelta a SLOT_SELECTION", async () => {
    const { prepared } = await prepareFor();
    const late = depsAt(db, 11); // vigencia de la intención: 10 minutos
    expect(await confirm(prepared.confirmationToken, OWNER_C1, late)).toEqual({ ok: false, error: { code: "INTENT_EXPIRED" } });
    expect(await db.bookingIntent.findUniqueOrThrow({ where: { id: prepared.intentId } })).toMatchObject({ status: "EXPIRED" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("SLOT_SELECTION");
    expect(await db.booking.count()).toBe(0);
    expect(await confirm(prepared.confirmationToken, OWNER_C1, late)).toMatchObject({ ok: false, error: { code: "INTENT_EXPIRED" } });
  });

  it("token de otro cliente → UNAUTHORIZED sin revelar ni modificar la intención", async () => {
    const { prepared } = await prepareFor();
    expect(await confirm(prepared.confirmationToken, OWNER_C2)).toEqual({ ok: false, error: { code: "UNAUTHORIZED", detail: "NO_ACTIVE_OWNERSHIP" } });
    expect(await confirm(prepared.confirmationToken, OWNER_C3)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } }); // titular anterior de V1
    expect(await db.bookingIntent.findUniqueOrThrow({ where: { id: prepared.intentId } })).toMatchObject({ status: "AWAITING_USER" });
    expect(await db.booking.count()).toBe(0);
  });

  it("el agente nunca confirma; un asesor con el vehículo en su cartera sí puede", async () => {
    const { prepared } = await prepareFor();
    expect(await confirm(prepared.confirmationToken, AGENT_C1)).toEqual({ ok: false, error: { code: "AGENT_CANNOT_CONFIRM" } });
    expect(await confirm(prepared.confirmationToken, actor("comp", "COMPLIANCE"))).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(must(await confirm(prepared.confirmationToken, ADVISOR))).toMatchObject({ status: "CONFIRMED" });
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ confirmedById: ADVISOR.actorId, confirmedByRole: "ADVISOR" });
  });

  it("re-preparar con la misma clave reemite el token: el anterior deja de servir", async () => {
    const { quote, slots, prepared } = await prepareFor();
    const event = await db.journeyEvent.findFirstOrThrow({ where: { type: "BOOKING_INTENT_CREATED" } });
    const again = must(await prepareBooking(depsAt(db), { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, quoteId: quote.quoteId, slotRef: slots.slots[0].slotRef, traceId: "t", idempotencyKey: event.idempotencyKey!.replace(/^intent:/, "") }));
    expect(again).toMatchObject({ intentId: prepared.intentId, reissued: true });
    expect(await confirm(prepared.confirmationToken)).toEqual({ ok: false, error: { code: "INVALID_TOKEN" } });
    expect(must(await confirm(again.confirmationToken))).toMatchObject({ status: "CONFIRMED" });
    expect(await db.bookingIntent.count()).toBe(1);
  });

  it("la BD impide que el agente figure como confirmador de una reserva", async () => {
    const { prepared } = await prepareFor();
    const intent = await db.bookingIntent.findUniqueOrThrow({ where: { id: prepared.intentId } });
    await expect(
      db.booking.create({
        data: { vehicleId: V.v1, quoteId: intent.quoteId, serviceCode: OIL, intentId: intent.id, workshopId: intent.workshopId, slotExternalRef: intent.slotExternalRef, startsAt: intent.slotStartsAt, status: "PENDING", idempotencyKey: "x", source: "MOCK", traceId: "t", confirmedById: "agent", confirmedByRole: "SYSTEM_AGENT" },
      }),
    ).rejects.toThrow(/Booking_confirmed_by_human/);
  });
});

describe("Excepciones al confirmar", () => {
  it("IT-14: cotización vencida al confirmar → QUOTE_EXPIRED, sin reserva, recotización", async () => {
    const { prepared, quote } = await prepareFor();
    // La cotización vence antes que la intención (relativo al reloj demo, no al reloj real).
    await db.quote.update({ where: { id: quote.quoteId }, data: { validUntil: new Date(DEMO_NOW.getTime() - 1000) } });
    await db.bookingIntent.update({ where: { id: prepared.intentId }, data: { expiresAt: new Date("2030-01-01T00:00:00Z") } });
    expect(await confirm(prepared.confirmationToken)).toEqual({ ok: false, error: { code: "QUOTE_EXPIRED" } });
    expect(await db.booking.count()).toBe(0);
    expect(await db.mockBooking.count()).toBe(0);
    expect(await db.quote.findUniqueOrThrow({ where: { id: quote.quoteId } })).toMatchObject({ status: "EXPIRED" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("RECOMMENDATION_PRESENTED");
    // Recotizar vuelve a habilitar el flujo.
    expect(must(await quoteFor(depsAt(db)))).toMatchObject({ journeyState: "QUOTE_PRESENTED" });
  });

  it("el taller rechaza por cotización vencida de su lado → FAILED(QUOTE_EXPIRED)", async () => {
    const { prepared, quote } = await prepareFor();
    const ref = (await db.quote.findUniqueOrThrow({ where: { id: quote.quoteId } })).externalQuoteRef!;
    await db.mockQuote.update({ where: { externalRef: ref }, data: { validUntil: new Date("2020-01-01T00:00:00Z") } });
    expect(await confirm(prepared.confirmationToken)).toMatchObject({ ok: false, error: { code: "QUOTE_EXPIRED" } });
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: "FAILED", failureCode: "QUOTE_EXPIRED" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("RECOMMENDATION_PRESENTED");
  });

  it("SLOT_CONFLICT: el cupo desaparece antes de confirmar → FAILED y nueva selección", async () => {
    const { prepared } = await prepareFor();
    await activateScenario(db, "SLOT_CONFLICT_ON_NEXT_BOOKING");
    expect(await confirm(prepared.confirmationToken)).toMatchObject({ ok: false, error: { code: "SLOT_CONFLICT" } });
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: "FAILED", failureCode: "SLOT_CONFLICT", externalBookingRef: null });
    expect((await findJourney(db, KEY_V1))!.state).toBe("SLOT_SELECTION");
    expect(await db.mockBooking.count()).toBe(0);
  });

  it("taller caído ANTES de crear la reserva → FAILED(WORKSHOP_UNAVAILABLE), nada creado en el taller", async () => {
    const { prepared } = await prepareFor();
    await activateScenario(db, "WORKSHOP_DOWN");
    expect(await confirm(prepared.confirmationToken)).toMatchObject({ ok: false, error: { code: "WORKSHOP_UNAVAILABLE" } });
    expect(await db.mockBooking.count()).toBe(0);
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: "FAILED", failureCode: "WORKSHOP_UNAVAILABLE" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("SLOT_SELECTION");
  });

  it("SAFETY_ESCALATED: una confirmación tardía tras la señal se bloquea sin llamar al taller", async () => {
    const { prepared } = await prepareFor();
    must(await reportSafetySignal(depsAt(db), { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, source: "SAFETY_LEXICON", summary: "Síntoma de frenos (sintético)", traceId: "t", idempotencyKey: "s-1" }));
    expect(await confirm(prepared.confirmationToken)).toEqual({ ok: false, error: { code: "SAFETY_ESCALATED" } });
    expect(await db.booking.count()).toBe(0);
    expect(await db.mockBooking.count()).toBe(0);
    expect(await db.bookingIntent.findUniqueOrThrow({ where: { id: prepared.intentId } })).toMatchObject({ status: "REJECTED" });
  });

  it("SAFETY_SIGNAL durante la llamada al taller → la reserva se compensa (cancelada en el taller), nunca BOOKED", async () => {
    const { prepared } = await prepareFor();
    const base = depsAt(db);
    const racing: WorkshopPort = {
      ...base.workshop,
      getQuote: (r) => base.workshop.getQuote(r),
      listSlots: (r) => base.workshop.listSlots(r),
      getSlot: (r) => base.workshop.getSlot(r),
      findBooking: (r) => base.workshop.findBooking(r),
      cancelBooking: (r) => base.workshop.cancelBooking(r),
      openWorkOrder: (r) => base.workshop.openWorkOrder(r),
      completeWorkOrder: (r) => base.workshop.completeWorkOrder(r),
      async createBooking(req, key) {
        const result = await base.workshop.createBooking(req, key);
        must(await reportSafetySignal(base, { actor: AGENT_C1, vehicleId: V.v1, serviceCode: OIL, source: "SAFETY_LEXICON", summary: "Síntoma (sintético)", traceId: "t", idempotencyKey: "s-race" }));
        return result;
      },
    };
    const r = await confirmBooking({ ...base, workshop: racing }, { actor: OWNER_C1, confirmationToken: prepared.confirmationToken, traceId: "t" });
    expect(r).toMatchObject({ ok: false, error: { code: "SAFETY_ESCALATED", detail: "BOOKING_CANCELLED_AT_WORKSHOP" } });
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: "CANCELLED", failureCode: "COMPENSATED_SAFETY_ESCALATED" });
    expect(await db.mockBooking.findFirstOrThrow()).toMatchObject({ status: "CANCELLED" });
    expect(await slotRemaining(prepared.summary.slotRef)).toBe((await db.mockSlot.findUniqueOrThrow({ where: { id: prepared.summary.slotRef } })).capacity);
    expect((await findJourney(db, KEY_V1))!.state).toBe("SAFETY_ESCALATED");
    expect(await db.journeyEvent.count({ where: { type: "BOOKING_CONFIRMED" } })).toBe(0);
  });
});

describe("Resultado incierto y reconciliación", () => {
  it("timeout DESPUÉS de crear la reserva: queda PENDING sin folio; la reconciliación la confirma", async () => {
    const { prepared } = await prepareFor();
    await activateScenario(db, "BOOKING_TIMEOUT_AFTER_COMMIT");
    const r = must(await confirm(prepared.confirmationToken));
    expect(r).toMatchObject({ status: "PENDING_RECONCILIATION", escalatedCaseId: null });
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: "PENDING", externalBookingRef: null });
    expect(await db.mockBooking.count()).toBe(1); // existe en el taller
    expect((await findJourney(db, KEY_V1))!.state).toBe("AWAITING_CONFIRMATION");

    // Repetir el clic no reintenta a ciegas: devuelve el estado pendiente sin otra solicitud.
    expect(must(await confirm(prepared.confirmationToken))).toMatchObject({ status: "PENDING_RECONCILIATION", duplicate: true });

    const reconciled = must(await reconcileBooking(depsAt(db, 1), { actor: actor("job", "SYSTEM_JOB"), bookingId: r.bookingId, traceId: "t" }));
    expect(reconciled).toMatchObject({ status: "CONFIRMED", folio: (await db.mockBooking.findFirstOrThrow()).folio });
    expect(await db.mockBooking.count()).toBe(1);
    const journey = (await findJourney(db, KEY_V1))!;
    expect(journey.state).toBe("BOOKED");
    // El evento conserva al humano que confirmó, no al reconciliador.
    expect(await db.journeyEvent.findFirstOrThrow({ where: { type: "BOOKING_CONFIRMED" } })).toMatchObject({ actorId: OWNER_C1.actorId, actorRole: "OWNER" });
    expect((await verifyJourneyConsistency(db, journey.id)).ok).toBe(true);
  });

  it("timeout ANTES de procesar: la reconciliación no la encuentra → FAILED y nueva selección", async () => {
    const { prepared } = await prepareFor();
    await activateScenario(db, "BOOKING_TIMEOUT_BEFORE_COMMIT");
    const r = must(await confirm(prepared.confirmationToken));
    expect(r.status).toBe("PENDING_RECONCILIATION");
    expect(await reconcileBooking(depsAt(db, 1), { actor: actor("job", "SYSTEM_JOB"), bookingId: r.bookingId, traceId: "t" })).toMatchObject({
      ok: false,
      error: { code: "WORKSHOP_UNAVAILABLE" },
    });
    expect(await db.booking.findFirstOrThrow()).toMatchObject({ status: "FAILED", failureCode: "WORKSHOP_UNAVAILABLE" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("SLOT_SELECTION");
  });

  it("taller caído durante la reconciliación: sigue PENDING y escala a un humano tras el máximo de intentos", async () => {
    const { prepared } = await prepareFor();
    await activateScenario(db, "BOOKING_TIMEOUT_AFTER_COMMIT");
    const r = must(await confirm(prepared.confirmationToken));
    await activateScenario(db, "WORKSHOP_DOWN", null);
    const job = actor("job", "SYSTEM_JOB");
    for (let i = 1; i <= MAX_RECONCILIATION_ATTEMPTS; i++) {
      const out = must(await reconcileBooking(depsAt(db, i), { actor: job, bookingId: r.bookingId, traceId: "t" }));
      expect(out).toMatchObject({ status: "PENDING_RECONCILIATION", escalatedCaseId: i < MAX_RECONCILIATION_ATTEMPTS ? null : expect.any(String) });
    }
    const booking = await db.booking.findFirstOrThrow();
    expect(booking).toMatchObject({ status: "PENDING", reconciliationAttempts: MAX_RECONCILIATION_ATTEMPTS });
    expect(await db.humanCase.findUniqueOrThrow({ where: { id: booking.escalatedCaseId! } })).toMatchObject({ reason: "BOOKING_FAILURE", priority: "HIGH" });
    expect((await findJourney(db, KEY_V1))!.state).toBe("AWAITING_CONFIRMATION"); // sin mover el journey
    must(await reconcileBooking(depsAt(db, 9), { actor: job, bookingId: r.bookingId, traceId: "t" }));
    expect(await db.humanCase.count({ where: { reason: "BOOKING_FAILURE" } })).toBe(1);
  });

  it("solo el sistema o un asesor autorizado reconcilian", async () => {
    const { prepared } = await prepareFor();
    await activateScenario(db, "BOOKING_TIMEOUT_AFTER_COMMIT");
    const r = must(await confirm(prepared.confirmationToken));
    expect(await reconcileBooking(depsAt(db), { actor: OWNER_C1, bookingId: r.bookingId, traceId: "t" })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(must(await reconcileBooking(depsAt(db), { actor: ADVISOR, bookingId: r.bookingId, traceId: "t" }))).toMatchObject({ status: "CONFIRMED" });
  });
});

describe("Acceso a información de otros clientes", () => {
  it("un cliente no puede cotizar, listar cupos ni preparar reservas de un vehículo ajeno", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    const deps = depsAt(db);
    const quote = must(await quoteFor(deps));
    expect(await quoteFor(deps, V.v1, AGENT_C2)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await slotsFor(deps, V.v1, AGENT_C2)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await listWorkshops(deps, { actor: OWNER_C2, vehicleId: V.v1, serviceCode: OIL })).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await prepareBooking(deps, { actor: AGENT_C2, vehicleId: V.v1, serviceCode: OIL, quoteId: quote.quoteId, slotRef: "slot-t1-2", traceId: "t", idempotencyKey: "x" })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("no se puede preparar con la cotización de otro vehículo", async () => {
    await driveToRecommendation(db, V.v1, OWNER_C1, AGENT_C1);
    await driveToRecommendation(db, V.v2, OWNER_C2, AGENT_C2);
    const deps = depsAt(db);
    const q1 = must(await quoteFor(deps));
    must(await quoteFor(deps, V.v2, AGENT_C2));
    must(await slotsFor(deps, V.v2, AGENT_C2));
    expect(await prepareBooking(deps, { actor: AGENT_C2, vehicleId: V.v2, serviceCode: OIL, quoteId: q1.quoteId, slotRef: "slot-t1-2", traceId: "t", idempotencyKey: "x" })).toEqual({
      ok: false,
      error: { code: "QUOTE_MISMATCH" },
    });
  });
});
