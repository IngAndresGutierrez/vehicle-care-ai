/** Estados del journey UC-01 (ARCHITECTURE.md §6.1). */
export const JOURNEY_STATES = [
  "ACTIVATED",
  "PLAN_PENDING_VERIFICATION",
  "MONITORING",
  "NEED_DETECTED",
  "CONTACT_SUPPRESSED",
  "CONVERSATION_OPEN",
  "AWAITING_CONTEXT",
  "RECOMMENDATION_PRESENTED",
  "QUOTE_PRESENTED",
  "QUOTE_PENDING_HUMAN",
  "SLOT_SELECTION",
  "AWAITING_CONFIRMATION",
  "BOOKED",
  "IN_SERVICE",
  "SERVICE_COMPLETED",
  "FOLLOW_UP",
  "HUMAN_REVIEW",
  "SAFETY_ESCALATED",
  "CLOSED",
] as const;

export type JourneyState = (typeof JOURNEY_STATES)[number];

export const INITIAL_STATE: JourneyState = "ACTIVATED";

export const TERMINAL_STATES: ReadonlySet<JourneyState> = new Set(["CLOSED"]);

export const isTerminal = (state: JourneyState): boolean => TERMINAL_STATES.has(state);

/** Estados en los que el job puede aplicar evaluaciones sin interferir con una conversación o reserva en curso. */
export const JOB_MANAGED_STATES: ReadonlySet<JourneyState> = new Set([
  "ACTIVATED",
  "MONITORING",
  "NEED_DETECTED",
  "CONTACT_SUPPRESSED",
  "PLAN_PENDING_VERIFICATION",
]);

/** Estados en los que un recordatorio de mantenimiento tiene sentido. */
export const CONTACTABLE_STATES: ReadonlySet<JourneyState> = new Set(["NEED_DETECTED", "CONTACT_SUPPRESSED"]);
