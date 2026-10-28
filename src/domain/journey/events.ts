import type { DueStatus } from "../maintenance-engine/types";

/**
 * Eventos de negocio del journey. Son hechos tipados con identificadores, nunca texto conversacional:
 * los mensajes del chat viven en ConversationMessage y el texto de casos en HumanCase (ADR-015).
 */

export type HumanCaseReason =
  | "INSUFFICIENT_HISTORY"
  | "PLAN_NOT_VERIFIED"
  | "SAFETY_ESCALATION"
  | "QUOTE_UNAVAILABLE"
  | "BOOKING_FAILURE"
  | "CUSTOMER_REQUEST"
  | "DATA_CONFLICT";

export type BookingFailureCode = "SLOT_CONFLICT" | "NO_SLOTS" | "QUOTE_EXPIRED" | "WORKSHOP_UNAVAILABLE";

export type CaseResolutionOutcome = "CLEARED_FOR_SERVICE" | "REEVALUATE" | "CLOSE";

export type JourneyEvent =
  | {
      type: "EVALUATED";
      evaluationId: string;
      status: DueStatus;
      reasons: readonly string[];
      requiresOdometerConfirmation: boolean;
      cycleKey: string | null;
    }
  | { type: "PLAN_VALIDATED"; planVersionId: string }
  | { type: "CONTACT_SENT"; outboundMessageId: string; dedupKey: string }
  | { type: "CONTACT_SUPPRESSED"; outboundMessageId: string; dedupKey: string; reason: string }
  | { type: "OWNER_OPENED" }
  | { type: "ODOMETER_RECORDED"; readingId: string }
  | { type: "RECOMMENDATION_SHOWN"; evaluationId: string }
  | { type: "HUMAN_CASE_OPENED"; caseId: string; reason: HumanCaseReason }
  | { type: "QUOTE_ISSUED"; quoteId: string }
  | { type: "SLOTS_LISTED"; workshopId: string }
  | { type: "BOOKING_INTENT_CREATED"; intentId: string }
  | { type: "BOOKING_CONFIRMED"; intentId: string; bookingId: string; externalBookingRef: string }
  | { type: "BOOKING_FAILED"; intentId: string; code: BookingFailureCode }
  | { type: "INTENT_EXPIRED"; intentId: string }
  | { type: "BOOKING_CANCELLED"; bookingId: string }
  | { type: "WORK_ORDER_OPENED"; workOrderId: string }
  | { type: "WORK_ORDER_COMPLETED"; workOrderId: string; serviceRecordId: string }
  | { type: "REEVALUATED"; evaluationId: string; status: DueStatus }
  | { type: "FEEDBACK_RECEIVED" }
  | { type: "FOLLOW_UP_TIMEOUT" }
  | { type: "SAFETY_SIGNAL"; caseId: string; source: "SAFETY_LEXICON" | "AGENT_TOOL" | "STAFF" }
  | { type: "CASE_RESOLVED_BY_HUMAN"; caseId: string; outcome: CaseResolutionOutcome };

export type JourneyEventType = JourneyEvent["type"];

export const JOURNEY_EVENT_TYPES = [
  "EVALUATED",
  "PLAN_VALIDATED",
  "CONTACT_SENT",
  "CONTACT_SUPPRESSED",
  "OWNER_OPENED",
  "ODOMETER_RECORDED",
  "RECOMMENDATION_SHOWN",
  "HUMAN_CASE_OPENED",
  "QUOTE_ISSUED",
  "SLOTS_LISTED",
  "BOOKING_INTENT_CREATED",
  "BOOKING_CONFIRMED",
  "BOOKING_FAILED",
  "INTENT_EXPIRED",
  "BOOKING_CANCELLED",
  "WORK_ORDER_OPENED",
  "WORK_ORDER_COMPLETED",
  "REEVALUATED",
  "FEEDBACK_RECEIVED",
  "FOLLOW_UP_TIMEOUT",
  "SAFETY_SIGNAL",
  "CASE_RESOLVED_BY_HUMAN",
] as const satisfies readonly JourneyEventType[];

/** Payload persistible: el evento sin su tipo. */
export function eventPayload(event: JourneyEvent): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type, ...payload } = event;
  return payload;
}
