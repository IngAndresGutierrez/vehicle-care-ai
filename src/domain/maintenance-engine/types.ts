import type { IsoLocalDate } from "../shared/local-date";
import type { ReasonCode } from "./reasons";

/** Versión semántica del motor; se persiste con cada evaluación para reproducibilidad. */
export const ENGINE_VERSION = "1.0.0";

// ───────────────────────────── Datos de entrada ─────────────────────────────

export type TimingDrive = "BELT" | "CHAIN" | "UNKNOWN";
export type UsageCondition = "NORMAL" | "SEVERE";
export type PlanStatus = "DRAFT" | "VALIDATED" | "RETIRED";

/** Quién respalda el dato (ADR-011). Ortogonal a `DataOrigin`. */
export type Provenance = "WORKSHOP_VERIFIED" | "DELIVERY_INSPECTION" | "PRIOR_OWNER_DOCUMENT" | "OWNER_DECLARED";

/** Si el dato es real o sintético de demo (ADR-011). Un dato `SYNTHETIC` nunca se presenta como real. */
export type DataOrigin = "SYNTHETIC" | "REAL";

export interface MaintenanceRuleInput {
  ruleId: string;
  serviceCode: string;
  intervalKm: number | null;
  intervalMonths: number | null;
  /** Si la regla solo aplica a un tipo de distribución (p. ej. correa). */
  appliesToTimingDrive: "BELT" | "CHAIN" | null;
  /** Regla específica de una condición de uso; `null` = regla general. */
  usageCondition: UsageCondition | null;
  requiresUsageCondition: boolean;
  /** D-04: el servicio de alistamiento de entrega puede ser línea base. */
  allowDeliveryBaseline: boolean;
}

export interface PlanVersionInput {
  planVersionId: string;
  version: string;
  status: PlanStatus;
  /** Documento técnico citado. Para datos sintéticos empieza por `SYNTHETIC-DEMO:`. */
  sourceRef: string;
  dataOrigin: DataOrigin;
  rules: readonly MaintenanceRuleInput[];
}

export interface ServiceRecordInput {
  recordId: string;
  serviceCode: string;
  performedOn: IsoLocalDate;
  odometerKm: number;
  provenance: Provenance;
  dataOrigin: DataOrigin;
}

export interface OdometerReadingInput {
  readingId: string;
  valueKm: number;
  /** Instante ISO-8601 con zona. */
  observedAt: string;
  provenance: Provenance;
  dataOrigin: DataOrigin;
}

export interface EvaluationInput {
  vehicleId: string;
  serviceCode: string;
  spec: {
    engineCode: string | null;
    timingDrive: TimingDrive;
    market: string;
  };
  plan: PlanVersionInput | null;
  usageCondition: UsageCondition | null;
  /** Último servicio registrado para `serviceCode`, si existe. */
  lastService: ServiceRecordInput | null;
  /** Lectura de odómetro más reciente, si existe. */
  odometer: OdometerReadingInput | null;
  /** Lecturas previas, para detectar retrocesos. */
  odometerHistory: ReadonlyArray<{ valueKm: number; observedAt: string }>;
}

// ───────────────────────────── Políticas (no técnicas) ─────────────────────────────

/**
 * Umbrales de comunicación (ADR-012). Deciden cómo y cuándo avisar, nunca si un servicio
 * está técnicamente vencido.
 */
export interface CommunicationPolicy {
  policyVersion: string;
  dataOrigin: DataOrigin;
  /** Aviso anticipado: `UPCOMING` cuando faltan ≤ leadKm o ≤ leadDays (D-02). */
  leadKm: number;
  leadDays: number;
  /** Urgencia: `OVERDUE` cuando se excede el límite técnico en ≥ graceKm o ≥ graceDays (D-01). */
  overdueGraceKm: number;
  overdueGraceDays: number;
}

/** Calidad de datos: cuándo una lectura de odómetro deja de ser concluyente (D-03). */
export interface DataQualityPolicy {
  policyVersion: string;
  maxOdometerAgeDays: number;
}

export interface EvaluationPolicies {
  communication: CommunicationPolicy;
  dataQuality: DataQualityPolicy;
}

// ───────────────────────────── Resultado ─────────────────────────────

export type Dimension = "KM" | "TIME" | "BOTH";

/** Vencimiento técnico: depende solo del plan validado y del historial. */
export type TechnicalStatus = "NOT_DUE" | "DUE" | "NOT_APPLICABLE" | "UNKNOWN";

/** Clasificación de comunicación: se deriva del estado técnico aplicando la política comercial. */
export type CommunicationStatus = "NOT_DUE" | "UPCOMING" | "DUE" | "OVERDUE";

/** Estado consolidado que consumen journey, agente y UI. */
export type DueStatus = CommunicationStatus | "NOT_APPLICABLE" | "UNKNOWN";

export type SuggestedAction = "NONE" | "OFFER_QUOTE" | "CONFIRM_ODOMETER" | "HUMAN_REVIEW";

export interface DecisionStep {
  step: string;
  outcome: string;
  detail?: Record<string, unknown>;
}

export interface TechnicalAssessment {
  status: TechnicalStatus;
  /** Límites calculados a partir del plan. `null` si el estado es `UNKNOWN` o `NOT_APPLICABLE`. */
  dueBy: { km: number | null; date: IsoLocalDate | null } | null;
  /** Restante con signo: negativo = límite excedido. `km` es `null` si la lectura no es concluyente. */
  remaining: { km: number | null; days: number | null } | null;
  /** Dimensión(es) que alcanzaron el límite técnico. */
  reachedBy: Dimension | null;
}

export interface CommunicationAssessment {
  status: CommunicationStatus;
  policyVersion: string;
  /** Dimensión(es) que motivan la clasificación (`null` si `NOT_DUE`). */
  triggeredBy: Dimension | null;
}

export interface EvaluationResult {
  vehicleId: string;
  serviceCode: string;
  status: DueStatus;
  technical: TechnicalAssessment;
  /** `null` cuando el estado técnico es `UNKNOWN` o `NOT_APPLICABLE`. */
  communication: CommunicationAssessment | null;
  reasons: ReasonCode[];
  requiresOdometerConfirmation: boolean;
  suggestedAction: SuggestedAction;
  plan: { planVersionId: string; version: string; sourceRef: string } | null;
  ruleId: string | null;
  /** Rotulado obligatorio de datos sintéticos (ADR-011). */
  dataOrigin: { containsSyntheticData: boolean; syntheticSources: string[] };
  asOf: { instant: string; localDate: IsoLocalDate; timeZone: string };
  engineVersion: string;
  dataQualityPolicyVersion: string;
  inputHash: string;
  decisionTrace: DecisionStep[];
}
