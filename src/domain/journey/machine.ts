import type { ActorRole } from "../policies/access-policy";
import { err, ok, type Result } from "../shared/result";
import type { JourneyContext } from "./context";
import type { JourneyEvent, JourneyEventType } from "./events";
import { isTerminal, type JourneyState } from "./states";

/**
 * Máquina de estados del journey UC-01 (ARCHITECTURE.md §6). Pura y determinista: dado un estado, su contexto,
 * un evento de negocio y el actor, devuelve el nuevo estado o un error tipado. Nunca hace no-op silencioso.
 */

export interface JourneyActor {
  actorId: string;
  role: ActorRole;
}

export interface JourneySnapshot {
  state: JourneyState;
  context: JourneyContext;
}

export type JourneyEffect = { type: "INVALIDATE_BOOKING_INTENT"; intentId: string };

export interface TransitionOutcome {
  from: JourneyState;
  to: JourneyState;
  context: JourneyContext;
  effects: JourneyEffect[];
  ruleId: string;
}

export type JourneyError =
  | { code: "TERMINAL_STATE"; state: JourneyState; event: JourneyEventType }
  | { code: "ACTOR_NOT_PERMITTED"; role: ActorRole; event: JourneyEventType }
  | { code: "INVALID_TRANSITION"; state: JourneyState; event: JourneyEventType }
  | { code: "GUARD_REJECTED"; state: JourneyState; event: JourneyEventType; reason: string };

// ───────────────────────────── Actores por evento ─────────────────────────────

const HUMAN_STAFF: readonly ActorRole[] = ["ADVISOR", "COMPLIANCE"];
const WORKSHOP: readonly ActorRole[] = ["WORKSHOP_COORDINATOR", "TECHNICIAN"];
const ALL_ROLES: readonly ActorRole[] = [
  "OWNER",
  "ADVISOR",
  "WORKSHOP_COORDINATOR",
  "TECHNICIAN",
  "COMPLIANCE",
  "SYSTEM_AGENT",
  "SYSTEM_JOB",
];

/** Quién puede emitir cada evento. Denegación por defecto: lo no listado se rechaza. */
export const EVENT_ACTORS: Readonly<Record<JourneyEventType, readonly ActorRole[]>> = {
  EVALUATED: ["SYSTEM_JOB", "SYSTEM_AGENT", "ADVISOR"],
  PLAN_VALIDATED: ["SYSTEM_JOB", "COMPLIANCE"],
  CONTACT_SENT: ["SYSTEM_JOB"],
  CONTACT_SUPPRESSED: ["SYSTEM_JOB"],
  OWNER_OPENED: ["OWNER", "SYSTEM_AGENT"],
  ODOMETER_RECORDED: ["OWNER", "SYSTEM_AGENT", "ADVISOR", ...WORKSHOP],
  RECOMMENDATION_SHOWN: ["SYSTEM_AGENT", "ADVISOR"],
  HUMAN_CASE_OPENED: ALL_ROLES,
  QUOTE_ISSUED: ["SYSTEM_AGENT", "ADVISOR"],
  SLOTS_LISTED: ["SYSTEM_AGENT", "ADVISOR"],
  BOOKING_INTENT_CREATED: ["SYSTEM_AGENT", "ADVISOR"],
  // La confirmación es siempre humana: el agente nunca confirma una reserva (ADR-04).
  BOOKING_CONFIRMED: ["OWNER", "ADVISOR"],
  BOOKING_FAILED: ["OWNER", "SYSTEM_AGENT", "SYSTEM_JOB", "ADVISOR"],
  INTENT_EXPIRED: ["SYSTEM_JOB", "SYSTEM_AGENT"],
  BOOKING_CANCELLED: ["ADVISOR"],
  WORK_ORDER_OPENED: WORKSHOP,
  WORK_ORDER_COMPLETED: WORKSHOP,
  REEVALUATED: ["SYSTEM_JOB"],
  FEEDBACK_RECEIVED: ["OWNER", "SYSTEM_AGENT"],
  FOLLOW_UP_TIMEOUT: ["SYSTEM_JOB"],
  SAFETY_SIGNAL: ALL_ROLES,
  CASE_RESOLVED_BY_HUMAN: HUMAN_STAFF,
};

// ───────────────────────────── Reglas ─────────────────────────────

type EventOf<T extends JourneyEventType> = Extract<JourneyEvent, { type: T }>;

interface Rule<T extends JourneyEventType> {
  id: string;
  event: T;
  /** Estados de origen; "ANY_ACTIVE" = cualquier estado no terminal. */
  from: readonly JourneyState[] | "ANY_ACTIVE";
  when?: (e: EventOf<T>, ctx: JourneyContext) => boolean;
  to: JourneyState | "SAME";
  /** Devuelve el motivo de rechazo, o null si la guardia pasa. */
  guard?: (e: EventOf<T>, ctx: JourneyContext, actor: JourneyActor) => string | null;
  update?: (e: EventOf<T>, ctx: JourneyContext, from: JourneyState) => Partial<JourneyContext>;
  effects?: (e: EventOf<T>, ctx: JourneyContext) => JourneyEffect[];
}

type AnyRule = Rule<JourneyEventType>;
const rule = <T extends JourneyEventType>(r: Rule<T>): AnyRule => r as unknown as AnyRule;

const ACTIONABLE = new Set(["UPCOMING", "DUE", "OVERDUE"]);
const QUIET = new Set(["NOT_DUE", "NOT_APPLICABLE"]);
const hasPlanGap = (reasons: readonly string[]) => reasons.includes("PLAN_MISSING") || reasons.includes("PLAN_NOT_VERIFIED");
const evaluated = (e: EventOf<"EVALUATED">): Partial<JourneyContext> => ({
  lastEvaluation: { evaluationId: e.evaluationId, status: e.status, cycleKey: e.cycleKey },
});

const PRE_BOOKING_STATES: readonly JourneyState[] = [
  "ACTIVATED",
  "MONITORING",
  "NEED_DETECTED",
  "CONTACT_SUPPRESSED",
  "CONVERSATION_OPEN",
  "AWAITING_CONTEXT",
  "RECOMMENDATION_PRESENTED",
  "QUOTE_PRESENTED",
  "SLOT_SELECTION",
  "AWAITING_CONFIRMATION",
];

const invalidatePendingIntent = (_e: unknown, ctx: JourneyContext): JourneyEffect[] =>
  ctx.pendingIntentId ? [{ type: "INVALIDATE_BOOKING_INTENT", intentId: ctx.pendingIntentId }] : [];

const intentMatches = (e: { intentId: string }, ctx: JourneyContext) =>
  ctx.pendingIntentId === e.intentId ? null : "INTENT_MISMATCH";

/** Orden significativo: gana la primera regla cuyo evento, origen y condición coinciden. */
export const RULES: readonly AnyRule[] = [
  // ── Evaluación (job o conversación) ──
  rule({ id: "eval-plan-gap", event: "EVALUATED", from: ["ACTIVATED", "MONITORING"], when: (e) => hasPlanGap(e.reasons), to: "PLAN_PENDING_VERIFICATION", update: evaluated }),
  rule({ id: "eval-plan-gap-still", event: "EVALUATED", from: ["PLAN_PENDING_VERIFICATION"], when: (e) => hasPlanGap(e.reasons), to: "SAME", update: evaluated }),
  rule({ id: "eval-quiet", event: "EVALUATED", from: ["ACTIVATED", "MONITORING", "NEED_DETECTED", "CONTACT_SUPPRESSED"], when: (e) => QUIET.has(e.status), to: "MONITORING", update: evaluated }),
  rule({ id: "eval-need", event: "EVALUATED", from: ["ACTIVATED", "MONITORING"], when: (e) => ACTIONABLE.has(e.status), to: "NEED_DETECTED", update: evaluated }),
  rule({ id: "eval-need-still", event: "EVALUATED", from: ["NEED_DETECTED", "CONTACT_SUPPRESSED"], when: (e) => ACTIONABLE.has(e.status), to: "SAME", update: evaluated }),
  rule({ id: "eval-unknown", event: "EVALUATED", from: ["ACTIVATED", "MONITORING", "NEED_DETECTED", "CONTACT_SUPPRESSED"], when: (e) => e.status === "UNKNOWN", to: "SAME", update: evaluated }),
  rule({ id: "eval-needs-odometer", event: "EVALUATED", from: ["CONVERSATION_OPEN"], when: (e) => e.requiresOdometerConfirmation, to: "AWAITING_CONTEXT", update: evaluated }),
  rule({ id: "eval-context-complete", event: "EVALUATED", from: ["AWAITING_CONTEXT"], when: (e) => !e.requiresOdometerConfirmation, to: "CONVERSATION_OPEN", update: evaluated }),
  rule({ id: "eval-in-conversation", event: "EVALUATED", from: ["CONVERSATION_OPEN", "AWAITING_CONTEXT"], to: "SAME", update: evaluated }),
  rule({ id: "plan-validated", event: "PLAN_VALIDATED", from: ["PLAN_PENDING_VERIFICATION"], to: "ACTIVATED" }),

  // ── Contacto (EX-04) ──
  rule({ id: "contact-sent", event: "CONTACT_SENT", from: ["NEED_DETECTED"], to: "SAME" }),
  rule({ id: "contact-sent-after-suppression", event: "CONTACT_SENT", from: ["CONTACT_SUPPRESSED"], to: "NEED_DETECTED" }),
  rule({ id: "contact-suppressed", event: "CONTACT_SUPPRESSED", from: ["NEED_DETECTED", "CONTACT_SUPPRESSED"], to: "CONTACT_SUPPRESSED" }),

  // ── Conversación y recomendación ──
  rule({ id: "owner-opened", event: "OWNER_OPENED", from: ["NEED_DETECTED", "CONTACT_SUPPRESSED", "MONITORING"], to: "CONVERSATION_OPEN" }),
  rule({ id: "owner-reopened", event: "OWNER_OPENED", from: ["CONVERSATION_OPEN"], to: "SAME" }),
  rule({ id: "odometer-recorded", event: "ODOMETER_RECORDED", from: ["CONVERSATION_OPEN", "AWAITING_CONTEXT"], to: "SAME" }),
  rule({
    id: "recommendation-shown",
    event: "RECOMMENDATION_SHOWN",
    from: ["CONVERSATION_OPEN"],
    to: "RECOMMENDATION_PRESENTED",
    guard: (e, ctx) => {
      if (ctx.lastEvaluation?.evaluationId !== e.evaluationId) return "STALE_EVALUATION";
      return ACTIONABLE.has(ctx.lastEvaluation.status) ? null : "NOT_ACTIONABLE";
    },
  }),

  // ── Casos humanos (EX-01 y cotización pendiente) ──
  rule({ id: "case-safety-misuse", event: "HUMAN_CASE_OPENED", from: "ANY_ACTIVE", when: (e) => e.reason === "SAFETY_ESCALATION", to: "SAME", guard: () => "USE_SAFETY_SIGNAL" }),
  rule({
    id: "case-quote-unavailable",
    event: "HUMAN_CASE_OPENED",
    from: ["RECOMMENDATION_PRESENTED"],
    when: (e) => e.reason === "QUOTE_UNAVAILABLE",
    to: "QUOTE_PENDING_HUMAN",
    update: (e) => ({ openCaseId: e.caseId, openCaseReason: e.reason }),
  }),
  rule({
    id: "case-human-review",
    event: "HUMAN_CASE_OPENED",
    from: PRE_BOOKING_STATES,
    to: "HUMAN_REVIEW",
    update: (e) => ({ openCaseId: e.caseId, openCaseReason: e.reason, pendingIntentId: null }),
    effects: invalidatePendingIntent,
  }),
  rule({
    id: "case-recorded",
    event: "HUMAN_CASE_OPENED",
    from: ["PLAN_PENDING_VERIFICATION", "QUOTE_PENDING_HUMAN", "HUMAN_REVIEW", "BOOKED", "IN_SERVICE", "SERVICE_COMPLETED", "FOLLOW_UP"],
    to: "SAME",
    update: (e) => ({ openCaseId: e.caseId, openCaseReason: e.reason }),
  }),

  // ── Cotización y agenda ──
  rule({
    id: "quote-issued",
    event: "QUOTE_ISSUED",
    from: ["RECOMMENDATION_PRESENTED", "QUOTE_PRESENTED", "QUOTE_PENDING_HUMAN"],
    to: "QUOTE_PRESENTED",
    guard: (_e, ctx, actor) => (ctx.openCaseReason === "QUOTE_UNAVAILABLE" && actor.role !== "ADVISOR" ? "HUMAN_QUOTE_REQUIRED" : null),
    update: (e, ctx) => ({
      activeQuoteId: e.quoteId,
      ...(ctx.openCaseReason === "QUOTE_UNAVAILABLE" ? { openCaseId: null, openCaseReason: null } : {}),
    }),
  }),
  rule({ id: "slots-listed", event: "SLOTS_LISTED", from: ["QUOTE_PRESENTED", "SLOT_SELECTION"], to: "SLOT_SELECTION" }),
  rule({
    id: "intent-created",
    event: "BOOKING_INTENT_CREATED",
    from: ["SLOT_SELECTION"],
    to: "AWAITING_CONFIRMATION",
    guard: (_e, ctx) => (ctx.activeBookingId ? "ACTIVE_BOOKING_EXISTS" : ctx.activeQuoteId ? null : "NO_ACTIVE_QUOTE"),
    update: (e) => ({ pendingIntentId: e.intentId }),
  }),
  rule({
    id: "booking-confirmed",
    event: "BOOKING_CONFIRMED",
    from: ["AWAITING_CONFIRMATION"],
    to: "BOOKED",
    guard: (e, ctx) => (e.externalBookingRef.trim() === "" ? "MISSING_FOLIO" : intentMatches(e, ctx)),
    update: (e) => ({ pendingIntentId: null, activeBookingId: e.bookingId }),
  }),
  rule({
    id: "booking-failed-quote-expired",
    event: "BOOKING_FAILED",
    from: ["AWAITING_CONFIRMATION"],
    when: (e) => e.code === "QUOTE_EXPIRED",
    to: "RECOMMENDATION_PRESENTED",
    guard: intentMatches,
    update: () => ({ pendingIntentId: null, activeQuoteId: null }),
  }),
  rule({ id: "booking-failed", event: "BOOKING_FAILED", from: ["AWAITING_CONFIRMATION"], to: "SLOT_SELECTION", guard: intentMatches, update: () => ({ pendingIntentId: null }) }),
  rule({ id: "intent-expired", event: "INTENT_EXPIRED", from: ["AWAITING_CONFIRMATION"], to: "SLOT_SELECTION", guard: intentMatches, update: () => ({ pendingIntentId: null }) }),
  rule({
    id: "booking-cancelled",
    event: "BOOKING_CANCELLED",
    from: ["BOOKED"],
    to: "MONITORING",
    guard: (e, ctx) => (ctx.activeBookingId === e.bookingId ? null : "BOOKING_MISMATCH"),
    update: () => ({ activeBookingId: null, activeQuoteId: null }),
  }),

  // ── Taller y continuidad ──
  rule({ id: "work-order-opened", event: "WORK_ORDER_OPENED", from: ["BOOKED"], to: "IN_SERVICE" }),
  rule({ id: "work-order-completed", event: "WORK_ORDER_COMPLETED", from: ["IN_SERVICE"], to: "SERVICE_COMPLETED", update: () => ({ activeBookingId: null, activeQuoteId: null }) }),
  rule({ id: "reevaluated", event: "REEVALUATED", from: ["SERVICE_COMPLETED"], to: "FOLLOW_UP" }),
  rule({ id: "feedback", event: "FEEDBACK_RECEIVED", from: ["FOLLOW_UP"], to: "MONITORING" }),
  rule({ id: "follow-up-timeout", event: "FOLLOW_UP_TIMEOUT", from: ["FOLLOW_UP"], to: "MONITORING" }),

  // ── Seguridad (EX-02): desde cualquier estado activo; invalida la intención comercial pendiente ──
  rule({ id: "safety-repeat", event: "SAFETY_SIGNAL", from: ["SAFETY_ESCALATED"], to: "SAME" }),
  rule({
    id: "safety-signal",
    event: "SAFETY_SIGNAL",
    from: "ANY_ACTIVE",
    to: "SAFETY_ESCALATED",
    update: (e) => ({ openCaseId: e.caseId, openCaseReason: "SAFETY_ESCALATION", pendingIntentId: null }),
    effects: invalidatePendingIntent,
  }),

  // ── Resolución humana (solo ADVISOR/COMPLIANCE por EVENT_ACTORS; además, el caso abierto) ──
  rule({
    id: "safety-cleared",
    event: "CASE_RESOLVED_BY_HUMAN",
    from: ["SAFETY_ESCALATED"],
    when: (e) => e.outcome === "CLEARED_FOR_SERVICE",
    to: "CONVERSATION_OPEN",
    guard: (e, ctx) => (ctx.openCaseId === e.caseId ? null : "CASE_MISMATCH"),
    update: () => ({ openCaseId: null, openCaseReason: null }),
  }),
  rule({
    id: "review-reevaluate",
    event: "CASE_RESOLVED_BY_HUMAN",
    from: ["HUMAN_REVIEW"],
    when: (e) => e.outcome === "REEVALUATE",
    to: "ACTIVATED",
    guard: (e, ctx) => (ctx.openCaseId === e.caseId ? null : "CASE_MISMATCH"),
    update: () => ({ openCaseId: null, openCaseReason: null }),
  }),
  rule({
    id: "case-closed",
    event: "CASE_RESOLVED_BY_HUMAN",
    from: ["SAFETY_ESCALATED", "HUMAN_REVIEW", "QUOTE_PENDING_HUMAN"],
    when: (e) => e.outcome === "CLOSE",
    to: "CLOSED",
    guard: (e, ctx) => (ctx.openCaseId === e.caseId ? null : "CASE_MISMATCH"),
    update: () => ({ openCaseId: null, openCaseReason: null }),
  }),
];

const matchesFrom = (r: AnyRule, state: JourneyState) =>
  r.from === "ANY_ACTIVE" ? !isTerminal(state) : r.from.includes(state);

export function transition(
  snapshot: JourneySnapshot,
  event: JourneyEvent,
  actor: JourneyActor,
): Result<TransitionOutcome, JourneyError> {
  const { state, context } = snapshot;
  if (isTerminal(state)) return err({ code: "TERMINAL_STATE", state, event: event.type });
  if (!EVENT_ACTORS[event.type].includes(actor.role)) {
    return err({ code: "ACTOR_NOT_PERMITTED", role: actor.role, event: event.type });
  }

  const match = RULES.find((r) => r.event === event.type && matchesFrom(r, state) && (r.when?.(event, context) ?? true));
  if (!match) return err({ code: "INVALID_TRANSITION", state, event: event.type });

  const rejection = match.guard?.(event, context, actor) ?? null;
  if (rejection) return err({ code: "GUARD_REJECTED", state, event: event.type, reason: rejection });

  return ok({
    from: state,
    to: match.to === "SAME" ? state : match.to,
    context: { ...context, ...(match.update?.(event, context, state) ?? {}) },
    effects: match.effects?.(event, context) ?? [],
    ruleId: match.id,
  });
}
