/** Códigos de motivo que explican cada resultado del motor. Estables: se persisten y se muestran. */
export const REASON_CODES = [
  // Entrada
  "INVALID_INPUT",
  // Identidad técnica
  "PLAN_MISSING",
  "PLAN_NOT_VERIFIED",
  "ENGINE_UNIDENTIFIED",
  "RULE_MISSING_FOR_SERVICE",
  "RULE_WITHOUT_INTERVAL",
  "USAGE_CONDITION_REQUIRED",
  // Aplicabilidad
  "TIMING_DRIVE_UNKNOWN",
  "NOT_APPLICABLE_TIMING_DRIVE",
  // Consistencia
  "CONTRADICTORY_RECORDS",
  // Línea base
  "INSUFFICIENT_HISTORY",
  "BASELINE_NOT_DOCUMENTED",
  "DELIVERY_BASELINE_NOT_ALLOWED",
  // Odómetro
  "ODOMETER_MISSING",
  "ODOMETER_STALE",
  // Vencimiento técnico
  "WITHIN_INTERVAL",
  "KM_LIMIT_REACHED",
  "TIME_LIMIT_REACHED",
  // Política de comunicación
  "KM_WITHIN_LEAD",
  "TIME_WITHIN_LEAD",
  "KM_GRACE_EXCEEDED",
  "TIME_GRACE_EXCEEDED",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Motivos de `UNKNOWN` que se resuelven pidiendo el kilometraje al propietario. */
export const ODOMETER_REASONS: ReadonlySet<ReasonCode> = new Set(["ODOMETER_MISSING", "ODOMETER_STALE"]);
