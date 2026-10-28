/**
 * ⚠️ DATOS SINTÉTICOS DE DEMO — NO SON DATOS TÉCNICOS DE NINGÚN FABRICANTE (ADR-011).
 *
 * - Marca, modelos y códigos de motor son ficticios ("DemoMotors", "DEMO-*").
 * - El intervalo de aceite (5.000 km / 12 meses) reproduce la "regla de demo" del ejemplo
 *   sintético de PRD_Vehicle_Care_v1.md §7; no es una recomendación para un vehículo real.
 * - El intervalo de correa es un valor ficticio elegido solo para ejercitar el motor (EX-01).
 * - Umbrales de comunicación y calidad de datos son valores provisionales (D-01..D-03).
 */
import type {
  CommunicationPolicy,
  DataQualityPolicy,
  EvaluationInput,
  EvaluationPolicies,
  MaintenanceRuleInput,
  OdometerReadingInput,
  PlanVersionInput,
  ServiceRecordInput,
} from "../types";

/** Fecha de referencia de la demo: 28-oct-2026 12:00 en Bogotá. */
export const DEMO_NOW = new Date("2026-10-28T12:00:00-05:00");

export const DEMO_COMMUNICATION_POLICY: CommunicationPolicy = {
  policyVersion: "demo-comm-v1",
  dataOrigin: "SYNTHETIC",
  leadKm: 1_000,
  leadDays: 30,
  overdueGraceKm: 500,
  overdueGraceDays: 30,
};

export const DEMO_DATA_QUALITY_POLICY: DataQualityPolicy = {
  policyVersion: "demo-dq-v1",
  maxOdometerAgeDays: 30,
};

export const DEMO_POLICIES: EvaluationPolicies = {
  communication: DEMO_COMMUNICATION_POLICY,
  dataQuality: DEMO_DATA_QUALITY_POLICY,
};

export const OIL = "ENGINE_OIL_FILTER";
export const BELT = "TIMING_BELT";

export const DEMO_OIL_RULE: MaintenanceRuleInput = {
  ruleId: "rule-demo-oil",
  serviceCode: OIL,
  intervalKm: 5_000,
  intervalMonths: 12,
  appliesToTimingDrive: null,
  usageCondition: null,
  requiresUsageCondition: false,
  allowDeliveryBaseline: false,
};

export const DEMO_BELT_RULE: MaintenanceRuleInput = {
  ruleId: "rule-demo-belt",
  serviceCode: BELT,
  intervalKm: 100_000, // ficticio
  intervalMonths: 72, // ficticio
  appliesToTimingDrive: "BELT",
  usageCondition: null,
  requiresUsageCondition: false,
  allowDeliveryBaseline: false,
};

export const DEMO_PLAN: PlanVersionInput = {
  planVersionId: "planv-demo-1",
  version: "demo-2026.10-r1",
  status: "VALIDATED",
  sourceRef: "SYNTHETIC-DEMO: plan ficticio basado en el ejemplo sintético del PRD §7",
  dataOrigin: "SYNTHETIC",
  rules: [DEMO_OIL_RULE, DEMO_BELT_RULE],
};

export function serviceRecord(overrides: Partial<ServiceRecordInput> = {}): ServiceRecordInput {
  return {
    recordId: "svc-demo-1",
    serviceCode: OIL,
    performedOn: "2026-04-01",
    odometerKm: 70_000,
    provenance: "WORKSHOP_VERIFIED",
    dataOrigin: "SYNTHETIC",
    ...overrides,
  };
}

export function odometerReading(overrides: Partial<OdometerReadingInput> = {}): OdometerReadingInput {
  return {
    readingId: "odo-demo-1",
    valueKm: 74_200,
    observedAt: "2026-10-28T09:00:00-05:00",
    provenance: "OWNER_DECLARED",
    dataOrigin: "SYNTHETIC",
    ...overrides,
  };
}

/** V1 «Sedán demo»: cadena, aceite con historial verificado → ejemplo del PRD (UPCOMING por 800 km). */
export function v1OilInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    vehicleId: "veh-demo-v1",
    serviceCode: OIL,
    spec: { engineCode: "DEMO-1.6", timingDrive: "CHAIN", market: "CO" },
    plan: DEMO_PLAN,
    usageCondition: "NORMAL",
    lastService: serviceRecord(),
    odometer: odometerReading(),
    odometerHistory: [{ valueKm: 70_000, observedAt: "2026-04-01T10:00:00-05:00" }],
    ...overrides,
  };
}

/** V2 «SUV demo»: correa, regla demo validada, 95.000 km verificados y sin constancia de cambio (EX-01). */
export function v2BeltInput(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    vehicleId: "veh-demo-v2",
    serviceCode: BELT,
    spec: { engineCode: "DEMO-2.0", timingDrive: "BELT", market: "CO" },
    plan: DEMO_PLAN,
    usageCondition: "NORMAL",
    lastService: null,
    odometer: odometerReading({
      readingId: "odo-demo-v2",
      valueKm: 95_000,
      observedAt: "2026-10-20T10:00:00-05:00",
      provenance: "DELIVERY_INSPECTION",
    }),
    odometerHistory: [],
    ...overrides,
  };
}
