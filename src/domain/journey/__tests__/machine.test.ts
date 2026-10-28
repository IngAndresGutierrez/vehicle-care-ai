import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, type JourneyContext } from "../context";
import { JOURNEY_EVENT_TYPES, type JourneyEvent, type JourneyEventType } from "../events";
import { EVENT_ACTORS, transition, type JourneyActor, type JourneySnapshot } from "../machine";
import { isRedundantEvaluation } from "../redundancy";
import { JOURNEY_STATES, type JourneyState } from "../states";
import { allowedTools, COMMERCIAL_TOOLS, isToolAllowed } from "../tools";

const JOB: JourneyActor = { actorId: "job", role: "SYSTEM_JOB" };
const AGENT: JourneyActor = { actorId: "agent", role: "SYSTEM_AGENT" };
const OWNER: JourneyActor = { actorId: "owner", role: "OWNER" };
const ADVISOR: JourneyActor = { actorId: "adv", role: "ADVISOR" };
const COMPLIANCE: JourneyActor = { actorId: "comp", role: "COMPLIANCE" };
const WORKSHOP: JourneyActor = { actorId: "ws", role: "WORKSHOP_COORDINATOR" };

const snap = (state: JourneyState, context: Partial<JourneyContext> = {}): JourneySnapshot => ({
  state,
  context: { ...EMPTY_CONTEXT, ...context },
});
const evaluated = (overrides: Partial<Extract<JourneyEvent, { type: "EVALUATED" }>> = {}): Extract<JourneyEvent, { type: "EVALUATED" }> => ({
  type: "EVALUATED",
  evaluationId: "ev-1",
  status: "UPCOMING",
  reasons: ["WITHIN_INTERVAL", "KM_WITHIN_LEAD"],
  requiresOdometerConfirmation: false,
  cycleKey: "v1:OIL:rule:svc",
  ...overrides,
});

/** Un ejemplo válido de cada tipo de evento, para barridos exhaustivos. */
const SAMPLE_EVENTS: Record<JourneyEventType, JourneyEvent> = {
  EVALUATED: evaluated(),
  PLAN_VALIDATED: { type: "PLAN_VALIDATED", planVersionId: "pv" },
  CONTACT_SENT: { type: "CONTACT_SENT", outboundMessageId: "m", dedupKey: "k" },
  CONTACT_SUPPRESSED: { type: "CONTACT_SUPPRESSED", outboundMessageId: "m", dedupKey: "k", reason: "CONSENT_REQUIRED" },
  OWNER_OPENED: { type: "OWNER_OPENED" },
  ODOMETER_RECORDED: { type: "ODOMETER_RECORDED", readingId: "r" },
  RECOMMENDATION_SHOWN: { type: "RECOMMENDATION_SHOWN", evaluationId: "ev-1" },
  HUMAN_CASE_OPENED: { type: "HUMAN_CASE_OPENED", caseId: "case-1", reason: "INSUFFICIENT_HISTORY" },
  QUOTE_ISSUED: { type: "QUOTE_ISSUED", quoteId: "q" },
  SLOTS_LISTED: { type: "SLOTS_LISTED", workshopId: "w" },
  BOOKING_INTENT_CREATED: { type: "BOOKING_INTENT_CREATED", intentId: "i" },
  BOOKING_CONFIRMED: { type: "BOOKING_CONFIRMED", intentId: "i", bookingId: "b", externalBookingRef: "VC-1" },
  BOOKING_FAILED: { type: "BOOKING_FAILED", intentId: "i", code: "SLOT_CONFLICT" },
  INTENT_EXPIRED: { type: "INTENT_EXPIRED", intentId: "i" },
  BOOKING_CANCELLED: { type: "BOOKING_CANCELLED", bookingId: "b" },
  WORK_ORDER_OPENED: { type: "WORK_ORDER_OPENED", workOrderId: "wo" },
  WORK_ORDER_COMPLETED: { type: "WORK_ORDER_COMPLETED", workOrderId: "wo", serviceRecordId: "sr" },
  REEVALUATED: { type: "REEVALUATED", evaluationId: "ev-2", status: "NOT_DUE" },
  FEEDBACK_RECEIVED: { type: "FEEDBACK_RECEIVED" },
  FOLLOW_UP_TIMEOUT: { type: "FOLLOW_UP_TIMEOUT" },
  SAFETY_SIGNAL: { type: "SAFETY_SIGNAL", caseId: "safe-1", source: "SAFETY_LEXICON" },
  CASE_RESOLVED_BY_HUMAN: { type: "CASE_RESOLVED_BY_HUMAN", caseId: "case-1", outcome: "CLOSE" },
};

const to = (s: JourneySnapshot, e: JourneyEvent, a: JourneyActor) => {
  const r = transition(s, e, a);
  if (!r.ok) throw new Error(`transición rechazada: ${JSON.stringify(r.error)}`);
  return r.value;
};

describe("FSM — casos del plan (FSM-01…FSM-12)", () => {
  it("FSM-01 ACTIVATED + EVALUATED(UPCOMING) → NEED_DETECTED y guarda la evaluación", () => {
    const out = to(snap("ACTIVATED"), evaluated(), JOB);
    expect(out.to).toBe("NEED_DETECTED");
    expect(out.context.lastEvaluation).toEqual({ evaluationId: "ev-1", status: "UPCOMING", cycleKey: "v1:OIL:rule:svc" });
  });

  it("FSM-02 NEED_DETECTED + CONTACT_SUPPRESSED → CONTACT_SUPPRESSED", () => {
    expect(to(snap("NEED_DETECTED"), SAMPLE_EVENTS.CONTACT_SUPPRESSED, JOB).to).toBe("CONTACT_SUPPRESSED");
  });

  it("FSM-03 CONVERSATION_OPEN + EVALUATED(requiere odómetro) → AWAITING_CONTEXT", () => {
    expect(to(snap("CONVERSATION_OPEN"), evaluated({ status: "UNKNOWN", requiresOdometerConfirmation: true }), AGENT).to).toBe("AWAITING_CONTEXT");
  });

  it("FSM-04 RECOMMENDATION_PRESENTED + caso QUOTE_UNAVAILABLE → QUOTE_PENDING_HUMAN", () => {
    const out = to(snap("RECOMMENDATION_PRESENTED"), { type: "HUMAN_CASE_OPENED", caseId: "c-q", reason: "QUOTE_UNAVAILABLE" }, AGENT);
    expect(out.to).toBe("QUOTE_PENDING_HUMAN");
    expect(out.context).toMatchObject({ openCaseId: "c-q", openCaseReason: "QUOTE_UNAVAILABLE" });
  });

  it("FSM-05 BOOKING_CONFIRMED sin folio se rechaza con error tipado", () => {
    const r = transition(snap("AWAITING_CONFIRMATION", { pendingIntentId: "i" }), { ...SAMPLE_EVENTS.BOOKING_CONFIRMED, externalBookingRef: "  " } as JourneyEvent, OWNER);
    expect(r).toEqual({ ok: false, error: { code: "GUARD_REJECTED", state: "AWAITING_CONFIRMATION", event: "BOOKING_CONFIRMED", reason: "MISSING_FOLIO" } });
  });

  it("FSM-06 BOOKING_FAILED(SLOT_CONFLICT) → SLOT_SELECTION y libera la intención", () => {
    const out = to(snap("AWAITING_CONFIRMATION", { pendingIntentId: "i" }), SAMPLE_EVENTS.BOOKING_FAILED, OWNER);
    expect(out.to).toBe("SLOT_SELECTION");
    expect(out.context.pendingIntentId).toBeNull();
  });

  it("FSM-07 BOOKING_FAILED(QUOTE_EXPIRED) → RECOMMENDATION_PRESENTED (recotizar)", () => {
    const out = to(snap("AWAITING_CONFIRMATION", { pendingIntentId: "i", activeQuoteId: "q" }), { type: "BOOKING_FAILED", intentId: "i", code: "QUOTE_EXPIRED" }, OWNER);
    expect(out.to).toBe("RECOMMENDATION_PRESENTED");
    expect(out.context.activeQuoteId).toBeNull();
  });

  it("FSM-08 SAFETY_SIGNAL desde cualquier estado activo → SAFETY_ESCALATED", () => {
    for (const state of JOURNEY_STATES.filter((s) => s !== "CLOSED")) {
      const out = to(snap(state), SAMPLE_EVENTS.SAFETY_SIGNAL, OWNER);
      expect(out.to, state).toBe("SAFETY_ESCALATED");
    }
  });

  it("FSM-09 el agente no puede resolver un caso de seguridad", () => {
    const r = transition(snap("SAFETY_ESCALATED", { openCaseId: "safe-1" }), { type: "CASE_RESOLVED_BY_HUMAN", caseId: "safe-1", outcome: "CLEARED_FOR_SERVICE" }, AGENT);
    expect(r).toMatchObject({ ok: false, error: { code: "ACTOR_NOT_PERMITTED", role: "SYSTEM_AGENT" } });
  });

  it("FSM-10 un asesor resuelve con CLEARED_FOR_SERVICE → CONVERSATION_OPEN", () => {
    const out = to(snap("SAFETY_ESCALATED", { openCaseId: "safe-1" }), { type: "CASE_RESOLVED_BY_HUMAN", caseId: "safe-1", outcome: "CLEARED_FOR_SERVICE" }, ADVISOR);
    expect(out.to).toBe("CONVERSATION_OPEN");
    expect(out.context.openCaseId).toBeNull();
  });

  it("FSM-11 el propietario no puede completar una orden de trabajo", () => {
    expect(transition(snap("IN_SERVICE"), SAMPLE_EVENTS.WORK_ORDER_COMPLETED, OWNER)).toMatchObject({ ok: false, error: { code: "ACTOR_NOT_PERMITTED" } });
    expect(to(snap("IN_SERVICE"), SAMPLE_EVENTS.WORK_ORDER_COMPLETED, WORKSHOP).to).toBe("SERVICE_COMPLETED");
  });

  it("FSM-12 allowedTools(SAFETY_ESCALATED) no incluye herramientas comerciales", () => {
    const tools = allowedTools("SAFETY_ESCALATED");
    for (const commercial of COMMERCIAL_TOOLS) expect(tools).not.toContain(commercial);
    expect(tools).not.toContain("createHumanCase");
    expect(tools).toEqual(["getVehicleProfile", "getServiceHistory"]);
  });
});

describe("FSM — seguridad y handoff humano", () => {
  it("SAFETY_SIGNAL invalida la intención de reserva pendiente y registra el caso", () => {
    const out = to(snap("AWAITING_CONFIRMATION", { pendingIntentId: "intent-9" }), SAMPLE_EVENTS.SAFETY_SIGNAL, AGENT);
    expect(out.effects).toEqual([{ type: "INVALIDATE_BOOKING_INTENT", intentId: "intent-9" }]);
    expect(out.context).toMatchObject({ pendingIntentId: null, openCaseId: "safe-1", openCaseReason: "SAFETY_ESCALATION" });
  });

  it("una segunda señal no reemplaza el caso abierto ni sale del estado", () => {
    const out = to(snap("SAFETY_ESCALATED", { openCaseId: "safe-1" }), { ...SAMPLE_EVENTS.SAFETY_SIGNAL, caseId: "safe-2" } as JourneyEvent, OWNER);
    expect(out.to).toBe("SAFETY_ESCALATED");
    expect(out.context.openCaseId).toBe("safe-1");
  });

  it("en SAFETY_ESCALATED se rechaza todo evento comercial", () => {
    const commercial: JourneyEventType[] = ["RECOMMENDATION_SHOWN", "QUOTE_ISSUED", "SLOTS_LISTED", "BOOKING_INTENT_CREATED", "BOOKING_CONFIRMED", "OWNER_OPENED", "EVALUATED"];
    for (const type of commercial) {
      const actor = EVENT_ACTORS[type].includes("ADVISOR") ? ADVISOR : EVENT_ACTORS[type].includes("OWNER") ? OWNER : AGENT;
      const r = transition(snap("SAFETY_ESCALATED", { openCaseId: "safe-1", pendingIntentId: "i", activeQuoteId: "q" }), SAMPLE_EVENTS[type], actor);
      expect(r.ok, type).toBe(false);
    }
  });

  it("resolver exige el caso abierto correcto y una salida válida", () => {
    const s = snap("SAFETY_ESCALATED", { openCaseId: "safe-1" });
    expect(transition(s, { type: "CASE_RESOLVED_BY_HUMAN", caseId: "otro", outcome: "CLEARED_FOR_SERVICE" }, ADVISOR)).toMatchObject({
      ok: false,
      error: { code: "GUARD_REJECTED", reason: "CASE_MISMATCH" },
    });
    expect(transition(s, { type: "CASE_RESOLVED_BY_HUMAN", caseId: "safe-1", outcome: "REEVALUATE" }, ADVISOR)).toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSITION" },
    });
    expect(to(s, { type: "CASE_RESOLVED_BY_HUMAN", caseId: "safe-1", outcome: "CLOSE" }, COMPLIANCE).to).toBe("CLOSED");
  });

  it("HUMAN_CASE_OPENED no sirve para escalar seguridad: debe usarse SAFETY_SIGNAL", () => {
    expect(transition(snap("CONVERSATION_OPEN"), { type: "HUMAN_CASE_OPENED", caseId: "c", reason: "SAFETY_ESCALATION" }, AGENT)).toMatchObject({
      ok: false,
      error: { code: "GUARD_REJECTED", reason: "USE_SAFETY_SIGNAL" },
    });
  });

  it("EX-01: caso por historial insuficiente → HUMAN_REVIEW; el asesor lo devuelve a ACTIVATED", () => {
    const review = to(snap("CONVERSATION_OPEN"), SAMPLE_EVENTS.HUMAN_CASE_OPENED, AGENT);
    expect(review.to).toBe("HUMAN_REVIEW");
    expect(to({ state: review.to, context: review.context }, { type: "CASE_RESOLVED_BY_HUMAN", caseId: "case-1", outcome: "REEVALUATE" }, ADVISOR).to).toBe("ACTIVATED");
  });

  it("un caso abierto mientras se espera la confirmación invalida la intención", () => {
    const out = to(snap("AWAITING_CONFIRMATION", { pendingIntentId: "i" }), { type: "HUMAN_CASE_OPENED", caseId: "c", reason: "CUSTOMER_REQUEST" }, OWNER);
    expect(out.to).toBe("HUMAN_REVIEW");
    expect(out.effects).toEqual([{ type: "INVALIDATE_BOOKING_INTENT", intentId: "i" }]);
  });
});

describe("FSM — reservas y guardias", () => {
  it("el agente nunca confirma una reserva; propietario y asesor sí", () => {
    const s = snap("AWAITING_CONFIRMATION", { pendingIntentId: "i" });
    expect(transition(s, SAMPLE_EVENTS.BOOKING_CONFIRMED, AGENT)).toMatchObject({ ok: false, error: { code: "ACTOR_NOT_PERMITTED" } });
    expect(to(s, SAMPLE_EVENTS.BOOKING_CONFIRMED, OWNER)).toMatchObject({ to: "BOOKED", context: { activeBookingId: "b", pendingIntentId: null } });
  });

  it("la confirmación debe corresponder a la intención pendiente", () => {
    expect(transition(snap("AWAITING_CONFIRMATION", { pendingIntentId: "otra" }), SAMPLE_EVENTS.BOOKING_CONFIRMED, OWNER)).toMatchObject({
      ok: false,
      error: { reason: "INTENT_MISMATCH" },
    });
  });

  it("una reserva activa impide una segunda intención; sin cotización activa tampoco hay intención", () => {
    expect(transition(snap("SLOT_SELECTION", { activeBookingId: "b", activeQuoteId: "q" }), SAMPLE_EVENTS.BOOKING_INTENT_CREATED, AGENT)).toMatchObject({
      ok: false,
      error: { reason: "ACTIVE_BOOKING_EXISTS" },
    });
    expect(transition(snap("SLOT_SELECTION"), SAMPLE_EVENTS.BOOKING_INTENT_CREATED, AGENT)).toMatchObject({ ok: false, error: { reason: "NO_ACTIVE_QUOTE" } });
    expect(to(snap("SLOT_SELECTION", { activeQuoteId: "q" }), SAMPLE_EVENTS.BOOKING_INTENT_CREATED, AGENT).context.pendingIntentId).toBe("i");
  });

  it("la recomendación exige la última evaluación y que sea accionable", () => {
    const fresh = { lastEvaluation: { evaluationId: "ev-1", status: "UPCOMING" as const, cycleKey: null } };
    expect(to(snap("CONVERSATION_OPEN", fresh), SAMPLE_EVENTS.RECOMMENDATION_SHOWN, AGENT).to).toBe("RECOMMENDATION_PRESENTED");
    expect(transition(snap("CONVERSATION_OPEN", fresh), { type: "RECOMMENDATION_SHOWN", evaluationId: "ev-0" }, AGENT)).toMatchObject({
      ok: false,
      error: { reason: "STALE_EVALUATION" },
    });
    expect(
      transition(snap("CONVERSATION_OPEN", { lastEvaluation: { evaluationId: "ev-1", status: "UNKNOWN", cycleKey: null } }), SAMPLE_EVENTS.RECOMMENDATION_SHOWN, AGENT),
    ).toMatchObject({ ok: false, error: { reason: "NOT_ACTIONABLE" } });
  });

  it("con cotización pendiente de humano, solo el asesor emite la cotización", () => {
    const s = snap("QUOTE_PENDING_HUMAN", { openCaseId: "c-q", openCaseReason: "QUOTE_UNAVAILABLE" });
    expect(transition(s, SAMPLE_EVENTS.QUOTE_ISSUED, AGENT)).toMatchObject({ ok: false, error: { reason: "HUMAN_QUOTE_REQUIRED" } });
    expect(to(s, SAMPLE_EVENTS.QUOTE_ISSUED, ADVISOR)).toMatchObject({ to: "QUOTE_PRESENTED", context: { openCaseId: null, activeQuoteId: "q" } });
  });

  it("recotización desde SLOT_SELECTION cuando la cotización caduca (ADR-017)", () => {
    const out = to(snap("SLOT_SELECTION", { activeQuoteId: "q-old" }), { type: "QUOTE_ISSUED", quoteId: "q-new" }, AGENT);
    expect(out).toMatchObject({ to: "QUOTE_PRESENTED", context: { activeQuoteId: "q-new" } });
    expect(isToolAllowed("SLOT_SELECTION", "getQuote")).toBe(true);
  });

  it("recorrido feliz completo hasta MONITORING", () => {
    let s = snap("ACTIVATED");
    const steps: Array<[JourneyEvent, JourneyActor, JourneyState]> = [
      [evaluated(), JOB, "NEED_DETECTED"],
      [SAMPLE_EVENTS.CONTACT_SENT, JOB, "NEED_DETECTED"],
      [SAMPLE_EVENTS.OWNER_OPENED, OWNER, "CONVERSATION_OPEN"],
      [SAMPLE_EVENTS.RECOMMENDATION_SHOWN, AGENT, "RECOMMENDATION_PRESENTED"],
      [SAMPLE_EVENTS.QUOTE_ISSUED, AGENT, "QUOTE_PRESENTED"],
      [SAMPLE_EVENTS.SLOTS_LISTED, AGENT, "SLOT_SELECTION"],
      [SAMPLE_EVENTS.BOOKING_INTENT_CREATED, AGENT, "AWAITING_CONFIRMATION"],
      [SAMPLE_EVENTS.BOOKING_CONFIRMED, OWNER, "BOOKED"],
      [SAMPLE_EVENTS.WORK_ORDER_OPENED, WORKSHOP, "IN_SERVICE"],
      [SAMPLE_EVENTS.WORK_ORDER_COMPLETED, WORKSHOP, "SERVICE_COMPLETED"],
      [SAMPLE_EVENTS.REEVALUATED, JOB, "FOLLOW_UP"],
      [SAMPLE_EVENTS.FEEDBACK_RECEIVED, OWNER, "MONITORING"],
    ];
    for (const [event, actor, expected] of steps) {
      const out = to(s, event, actor);
      expect(out.to, event.type).toBe(expected);
      s = { state: out.to, context: out.context };
    }
    expect(s.context).toMatchObject({ activeBookingId: null, pendingIntentId: null, activeQuoteId: null });
  });
});

describe("FSM — evaluaciones del job", () => {
  it("plan faltante → PLAN_PENDING_VERIFICATION; plan validado → ACTIVATED", () => {
    const pending = to(snap("ACTIVATED"), evaluated({ status: "UNKNOWN", reasons: ["PLAN_MISSING"] }), JOB);
    expect(pending.to).toBe("PLAN_PENDING_VERIFICATION");
    expect(to({ state: pending.to, context: pending.context }, SAMPLE_EVENTS.PLAN_VALIDATED, COMPLIANCE).to).toBe("ACTIVATED");
  });

  it("UNKNOWN sin plan faltante mantiene el estado (queda registrado); NOT_DUE pasa a MONITORING", () => {
    expect(to(snap("ACTIVATED"), evaluated({ status: "UNKNOWN", reasons: ["INSUFFICIENT_HISTORY"] }), JOB).to).toBe("ACTIVATED");
    expect(to(snap("CONTACT_SUPPRESSED"), evaluated({ status: "NOT_DUE" }), JOB).to).toBe("MONITORING");
  });

  it("un contacto enviado tras una supresión vuelve a NEED_DETECTED", () => {
    expect(to(snap("CONTACT_SUPPRESSED"), SAMPLE_EVENTS.CONTACT_SENT, JOB).to).toBe("NEED_DETECTED");
  });

  it("isRedundantEvaluation: mismo estado, estado del motor y ciclo → redundante", () => {
    const s = snap("NEED_DETECTED", { lastEvaluation: { evaluationId: "ev-0", status: "UPCOMING", cycleKey: "v1:OIL:rule:svc" } });
    expect(isRedundantEvaluation(s, evaluated({ evaluationId: "ev-9" }), JOB)).toBe(true);
    expect(isRedundantEvaluation(s, evaluated({ status: "DUE" }), JOB)).toBe(false);
    expect(isRedundantEvaluation(s, evaluated({ cycleKey: "otro-ciclo" }), JOB)).toBe(false);
    expect(isRedundantEvaluation(snap("MONITORING", s.context), evaluated(), JOB)).toBe(false);
  });
});

describe("FSM — propiedades globales", () => {
  it("nunca lanza: todo par estado × evento × actor devuelve resultado o error tipado", () => {
    const actors = [JOB, AGENT, OWNER, ADVISOR, COMPLIANCE, WORKSHOP, { actorId: "t", role: "TECHNICIAN" as const }];
    for (const state of JOURNEY_STATES) {
      for (const type of JOURNEY_EVENT_TYPES) {
        for (const actor of actors) {
          const r = transition(snap(state, { pendingIntentId: "i", activeQuoteId: "q", activeBookingId: "b", openCaseId: "case-1" }), SAMPLE_EVENTS[type], actor);
          if (!r.ok) expect(["TERMINAL_STATE", "ACTOR_NOT_PERMITTED", "INVALID_TRANSITION", "GUARD_REJECTED"]).toContain(r.error.code);
          else expect(JOURNEY_STATES).toContain(r.value.to);
        }
      }
    }
  });

  it("CLOSED es terminal para cualquier evento", () => {
    for (const type of JOURNEY_EVENT_TYPES) {
      expect(transition(snap("CLOSED"), SAMPLE_EVENTS[type], ADVISOR)).toMatchObject({ ok: false, error: { code: "TERMINAL_STATE" } });
    }
  });

  it("una transición no definida es un error, no un no-op", () => {
    expect(transition(snap("MONITORING"), SAMPLE_EVENTS.BOOKING_CONFIRMED, OWNER)).toEqual({
      ok: false,
      error: { code: "INVALID_TRANSITION", state: "MONITORING", event: "BOOKING_CONFIRMED" },
    });
  });

  it("los sistemas (job y agente) nunca pueden resolver casos ni completar órdenes", () => {
    for (const type of ["CASE_RESOLVED_BY_HUMAN", "WORK_ORDER_COMPLETED", "BOOKING_CONFIRMED"] as const) {
      expect(EVENT_ACTORS[type]).not.toContain("SYSTEM_AGENT");
      expect(EVENT_ACTORS[type]).not.toContain("SYSTEM_JOB");
    }
  });

  it("allowedTools: cada estado activo salvo seguridad permite handoff; AWAITING_CONFIRMATION sin mutaciones comerciales", () => {
    for (const state of JOURNEY_STATES.filter((s) => s !== "CLOSED" && s !== "SAFETY_ESCALATED")) {
      expect(isToolAllowed(state, "createHumanCase"), state).toBe(true);
    }
    expect(allowedTools("AWAITING_CONFIRMATION").filter((t) => COMMERCIAL_TOOLS.has(t))).toEqual([]);
    expect(allowedTools("CLOSED")).toEqual([]);
    expect(isToolAllowed("QUOTE_PRESENTED", "getAvailableSlots")).toBe(true);
    expect(isToolAllowed("RECOMMENDATION_PRESENTED", "prepareBooking")).toBe(false);
  });
});
