/** Errores de negocio esperados de los casos de uso. Los bugs lanzan excepciones. */
export type AppErrorCode =
  | "UNAUTHORIZED"
  | "VEHICLE_NOT_FOUND"
  | "EVALUATION_NOT_FOUND"
  | "POLICY_MISSING"
  | "AMBIGUOUS_PLAN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  // Journey
  | "SAFETY_ESCALATED"
  | "JOURNEY_STATE_INVALID"
  | "CONFLICT"
  // Cotización, agenda y reserva (AGENT_DESIGN.md §4.2, ADR-017)
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_EXPIRED"
  | "QUOTE_MISMATCH"
  | "NO_SLOTS"
  | "SLOT_CONFLICT"
  | "WORKSHOP_UNAVAILABLE"
  | "ACTIVE_BOOKING_EXISTS"
  | "INVALID_TOKEN"
  | "INTENT_EXPIRED"
  | "INTENT_INVALIDATED"
  | "AGENT_CANNOT_CONFIRM"
  | "IDEMPOTENCY_MISMATCH"
  // Historial y taller
  | "ODOMETER_ROLLBACK"
  | "WORK_ORDER_STATE";

export interface AppError {
  code: AppErrorCode;
  detail?: string;
  /** true: reintentar más tarde puede tener éxito (p. ej. taller caído). */
  retryable?: boolean;
  /** Referencias útiles para el siguiente paso (caso humano abierto, reserva pendiente…). */
  refs?: Record<string, string>;
}

export const appError = (code: AppErrorCode, detail?: string, extra: Omit<AppError, "code" | "detail"> = {}): AppError => ({
  code,
  ...(detail ? { detail } : {}),
  ...extra,
});
