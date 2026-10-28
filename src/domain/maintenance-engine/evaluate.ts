import {
  BUSINESS_TIME_ZONE,
  addMonthsClamped,
  compareLocalDates,
  daysBetween,
  isValidLocalDate,
  toLocalDate,
  type IsoLocalDate,
} from "../shared/local-date";
import { canonicalJson, sha256Hex } from "./canonical-hash";
import { ODOMETER_REASONS, type ReasonCode } from "./reasons";
import {
  ENGINE_VERSION,
  type CommunicationAssessment,
  type DecisionStep,
  type Dimension,
  type EvaluationInput,
  type EvaluationPolicies,
  type EvaluationResult,
  type MaintenanceRuleInput,
  type ServiceRecordInput,
  type TechnicalAssessment,
} from "./types";

/** Prefijo obligatorio de `sourceRef` para planes y reglas sintéticas (ADR-011). */
export const SYNTHETIC_SOURCE_PREFIX = "SYNTHETIC-DEMO:";

// Instante ISO-8601 con zona explícita: sin zona, Date.parse dependería del proceso.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

interface DimensionOutcome {
  dimension: "KM" | "TIME";
  limitKm: number | null;
  limitDate: IsoLocalDate | null;
  /** km o días restantes con signo; `null` si la dimensión no es concluyente. */
  remaining: number | null;
  reached: boolean;
  conclusive: boolean;
  inconclusiveReason: "ODOMETER_MISSING" | "ODOMETER_STALE" | null;
}

/**
 * Evalúa si un servicio programado corresponde, de forma determinista y sin I/O (ARCHITECTURE.md §5).
 *
 * - El vencimiento técnico depende solo del plan validado y del historial.
 * - Los umbrales de comunicación (`UPCOMING`, `OVERDUE`) se aplican después y nunca lo alteran (ADR-012).
 * - Ante datos faltantes, no verificados o contradictorios devuelve `UNKNOWN`, nunca una cifra por defecto.
 * - No lanza por datos de negocio inválidos; solo si `now` no es una fecha válida (error de programación).
 */
export function evaluate(input: EvaluationInput, policies: EvaluationPolicies, now: Date): EvaluationResult {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("evaluate: `now` debe ser una fecha válida");
  }

  const trace: DecisionStep[] = [];
  const asOfDate = toLocalDate(now, BUSINESS_TIME_ZONE);
  let ruleId: string | null = null;

  const base = () => ({
    vehicleId: input.vehicleId,
    serviceCode: input.serviceCode,
    plan: input.plan
      ? { planVersionId: input.plan.planVersionId, version: input.plan.version, sourceRef: input.plan.sourceRef }
      : null,
    ruleId,
    dataOrigin: collectDataOrigin(input, policies),
    asOf: { instant: now.toISOString(), localDate: asOfDate, timeZone: BUSINESS_TIME_ZONE },
    engineVersion: ENGINE_VERSION,
    dataQualityPolicyVersion: policies.dataQuality.policyVersion,
    inputHash: sha256Hex(canonicalJson({ engineVersion: ENGINE_VERSION, input, policies, now: now.toISOString() })),
    decisionTrace: trace,
  });

  const unknown = (reasons: ReasonCode[], requiresOdometerConfirmation = false): EvaluationResult => ({
    ...base(),
    status: "UNKNOWN",
    technical: { status: "UNKNOWN", dueBy: null, remaining: null, reachedBy: null },
    communication: null,
    reasons,
    requiresOdometerConfirmation,
    suggestedAction: reasons.every((r) => ODOMETER_REASONS.has(r)) ? "CONFIRM_ODOMETER" : "HUMAN_REVIEW",
  });

  // 0. Entrada estructuralmente válida
  const issues = validate(input, policies);
  if (issues.length > 0) {
    trace.push({ step: "validate-input", outcome: "INVALID", detail: { issues } });
    return unknown(["INVALID_INPUT"]);
  }
  trace.push({ step: "validate-input", outcome: "OK" });

  // 1. Identidad técnica: plan validado, motor identificado y regla aplicable
  const { plan } = input;
  if (!plan) {
    trace.push({ step: "plan", outcome: "PLAN_MISSING" });
    return unknown(["PLAN_MISSING"]);
  }
  if (plan.status !== "VALIDATED") {
    trace.push({ step: "plan", outcome: "PLAN_NOT_VERIFIED", detail: { status: plan.status } });
    return unknown(["PLAN_NOT_VERIFIED"]);
  }
  trace.push({ step: "plan", outcome: "VALIDATED", detail: { version: plan.version, sourceRef: plan.sourceRef } });

  if (!input.spec.engineCode?.trim()) {
    trace.push({ step: "engine", outcome: "ENGINE_UNIDENTIFIED" });
    return unknown(["ENGINE_UNIDENTIFIED"]);
  }
  trace.push({ step: "engine", outcome: "IDENTIFIED", detail: { engineCode: input.spec.engineCode } });

  const selection = selectRule(plan.rules, input.serviceCode, input.usageCondition);
  if (!selection.ok) {
    trace.push({ step: "rule-selection", outcome: selection.reason });
    return unknown([selection.reason]);
  }
  const rule = selection.rule;
  ruleId = rule.ruleId;
  if (rule.intervalKm === null && rule.intervalMonths === null) {
    trace.push({ step: "rule-selection", outcome: "RULE_WITHOUT_INTERVAL", detail: { ruleId } });
    return unknown(["RULE_WITHOUT_INTERVAL"]);
  }
  trace.push({
    step: "rule-selection",
    outcome: "SELECTED",
    detail: { ruleId, intervalKm: rule.intervalKm, intervalMonths: rule.intervalMonths, usageCondition: rule.usageCondition },
  });

  // 2. Aplicabilidad: nunca asumir correa ni cadena
  if (rule.appliesToTimingDrive) {
    if (input.spec.timingDrive === "UNKNOWN") {
      trace.push({ step: "applicability", outcome: "TIMING_DRIVE_UNKNOWN", detail: { requires: rule.appliesToTimingDrive } });
      return unknown(["TIMING_DRIVE_UNKNOWN"]);
    }
    if (input.spec.timingDrive !== rule.appliesToTimingDrive) {
      trace.push({
        step: "applicability",
        outcome: "NOT_APPLICABLE",
        detail: { requires: rule.appliesToTimingDrive, vehicle: input.spec.timingDrive },
      });
      return {
        ...base(),
        status: "NOT_APPLICABLE",
        technical: { status: "NOT_APPLICABLE", dueBy: null, remaining: null, reachedBy: null },
        communication: null,
        reasons: ["NOT_APPLICABLE_TIMING_DRIVE"],
        requiresOdometerConfirmation: false,
        suggestedAction: "NONE",
      };
    }
  }
  trace.push({ step: "applicability", outcome: "APPLICABLE" });

  // 3. Consistencia de registros
  const contradictions = findContradictions(input, now, asOfDate);
  if (contradictions.length > 0) {
    trace.push({ step: "consistency", outcome: "CONTRADICTORY_RECORDS", detail: { contradictions } });
    return unknown(["CONTRADICTORY_RECORDS"]);
  }
  trace.push({ step: "consistency", outcome: "OK" });

  // 4. Línea base documentada: sin ella no hay cifra (no se usa 0 km ni la fecha de compra)
  const baseline = checkBaseline(input.lastService, rule);
  if (!baseline.ok) {
    trace.push({ step: "baseline", outcome: "INSUFFICIENT_HISTORY", detail: { reasons: baseline.reasons } });
    return unknown(baseline.reasons);
  }
  const lastService = baseline.lastService;
  trace.push({
    step: "baseline",
    outcome: "OK",
    detail: { recordId: lastService.recordId, performedOn: lastService.performedOn, odometerKm: lastService.odometerKm },
  });

  // 5. Vencimiento técnico por dimensión
  const dimensions: DimensionOutcome[] = [];
  if (rule.intervalKm !== null) {
    const km = evaluateKm(input, lastService, rule.intervalKm, policies.dataQuality.maxOdometerAgeDays, asOfDate);
    trace.push({ step: "dimension-km", outcome: describe(km), detail: { ...km } });
    dimensions.push(km);
  }
  if (rule.intervalMonths !== null) {
    const time = evaluateTime(lastService, rule.intervalMonths, asOfDate);
    trace.push({ step: "dimension-time", outcome: describe(time), detail: { ...time } });
    dimensions.push(time);
  }

  const reached = dimensions.filter((d) => d.conclusive && d.reached);
  const inconclusive = dimensions.filter((d) => !d.conclusive);
  const odometerReasons = dimensions.flatMap((d) => (d.inconclusiveReason ? [d.inconclusiveReason] : []));
  const requiresOdometerConfirmation = odometerReasons.length > 0;

  // Sin un límite alcanzado de forma concluyente, una dimensión dudosa impide afirmar "no vence".
  if (reached.length === 0 && inconclusive.length > 0) {
    trace.push({ step: "technical", outcome: "UNKNOWN", detail: { inconclusive: odometerReasons } });
    return unknown(odometerReasons, true);
  }

  const kmDim = dimensions.find((d) => d.dimension === "KM");
  const timeDim = dimensions.find((d) => d.dimension === "TIME");
  const technicalStatus = reached.length > 0 ? ("DUE" as const) : ("NOT_DUE" as const);
  const technical: TechnicalAssessment = {
    status: technicalStatus,
    dueBy: { km: kmDim?.limitKm ?? null, date: timeDim?.limitDate ?? null },
    remaining: { km: kmDim?.remaining ?? null, days: timeDim?.remaining ?? null },
    reachedBy: dimensionOf(reached),
  };
  const reasons: ReasonCode[] =
    technicalStatus === "DUE"
      ? reached.map((d) => (d.dimension === "KM" ? "KM_LIMIT_REACHED" : "TIME_LIMIT_REACHED"))
      : ["WITHIN_INTERVAL"];
  trace.push({ step: "technical", outcome: technical.status, detail: { ...technical } });

  // 6. Clasificación de comunicación (no altera el estado técnico)
  const comm = classifyCommunication(technicalStatus, dimensions, policies);
  reasons.push(...comm.reasons, ...odometerReasons);
  trace.push({ step: "communication", outcome: comm.assessment.status, detail: { ...comm.assessment } });

  return {
    ...base(),
    status: comm.assessment.status,
    technical,
    communication: comm.assessment,
    reasons,
    requiresOdometerConfirmation,
    suggestedAction: comm.assessment.status === "NOT_DUE" ? "NONE" : "OFFER_QUOTE",
  };
}

// ───────────────────────────── Pasos ─────────────────────────────

type RuleSelection =
  | { ok: true; rule: MaintenanceRuleInput }
  | { ok: false; reason: "RULE_MISSING_FOR_SERVICE" | "USAGE_CONDITION_REQUIRED" };

function selectRule(
  rules: readonly MaintenanceRuleInput[],
  serviceCode: string,
  usageCondition: EvaluationInput["usageCondition"],
): RuleSelection {
  const candidates = rules.filter((r) => r.serviceCode === serviceCode);
  if (candidates.length === 0) return { ok: false, reason: "RULE_MISSING_FOR_SERVICE" };

  const dependsOnUsage = candidates.some((r) => r.requiresUsageCondition || r.usageCondition !== null);
  if (dependsOnUsage && usageCondition === null) return { ok: false, reason: "USAGE_CONDITION_REQUIRED" };

  const rule =
    candidates.find((r) => r.usageCondition !== null && r.usageCondition === usageCondition) ??
    candidates.find((r) => r.usageCondition === null);
  return rule ? { ok: true, rule } : { ok: false, reason: "RULE_MISSING_FOR_SERVICE" };
}

function findContradictions(input: EvaluationInput, now: Date, asOfDate: IsoLocalDate): string[] {
  const found: string[] = [];
  const readings = [...input.odometerHistory, ...(input.odometer ? [input.odometer] : [])]
    .map((r) => ({ valueKm: r.valueKm, at: Date.parse(r.observedAt) }))
    .sort((a, b) => a.at - b.at);

  if (readings.some((r) => r.at > now.getTime())) found.push("ODOMETER_READING_IN_FUTURE");
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].valueKm < readings[i - 1].valueKm) {
      found.push("ODOMETER_DECREASING");
      break;
    }
  }

  const svc = input.lastService;
  if (svc) {
    if (compareLocalDates(svc.performedOn, asOfDate) > 0) found.push("SERVICE_DATE_IN_FUTURE");
    const laterLower = readings.some(
      (r) => compareLocalDates(toLocalDate(new Date(r.at)), svc.performedOn) > 0 && r.valueKm < svc.odometerKm,
    );
    if (laterLower) found.push("SERVICE_KM_ABOVE_LATER_READING");
  }
  return found;
}

type BaselineCheck = { ok: true; lastService: ServiceRecordInput } | { ok: false; reasons: ReasonCode[] };

function checkBaseline(lastService: ServiceRecordInput | null, rule: MaintenanceRuleInput): BaselineCheck {
  if (!lastService) return { ok: false, reasons: ["INSUFFICIENT_HISTORY"] };
  if (lastService.provenance === "OWNER_DECLARED") {
    return { ok: false, reasons: ["INSUFFICIENT_HISTORY", "BASELINE_NOT_DOCUMENTED"] };
  }
  if (lastService.provenance === "DELIVERY_INSPECTION" && !rule.allowDeliveryBaseline) {
    return { ok: false, reasons: ["INSUFFICIENT_HISTORY", "DELIVERY_BASELINE_NOT_ALLOWED"] };
  }
  return { ok: true, lastService };
}

/**
 * El odómetro es monótono: una lectura antigua es una cota inferior. Si ya alcanza el límite,
 * es concluyente; si no, la dimensión queda sin concluir y se pide confirmar el kilometraje.
 */
function evaluateKm(
  input: EvaluationInput,
  lastService: ServiceRecordInput,
  intervalKm: number,
  maxOdometerAgeDays: number,
  asOfDate: IsoLocalDate,
): DimensionOutcome {
  const limitKm = lastService.odometerKm + intervalKm;
  const outcome = { dimension: "KM" as const, limitKm, limitDate: null };
  if (!input.odometer) {
    return { ...outcome, remaining: null, reached: false, conclusive: false, inconclusiveReason: "ODOMETER_MISSING" };
  }

  const readingDate = toLocalDate(new Date(input.odometer.observedAt));
  // Si la lectura es anterior al servicio, el propio servicio es la observación más reciente.
  const latest =
    compareLocalDates(readingDate, lastService.performedOn) >= 0
      ? { km: input.odometer.valueKm, date: readingDate }
      : { km: lastService.odometerKm, date: lastService.performedOn };

  const stale = daysBetween(latest.date, asOfDate) > maxOdometerAgeDays;
  const remainingKm = limitKm - latest.km;
  const reached = remainingKm <= 0;
  const conclusive = reached || !stale;
  return {
    ...outcome,
    remaining: conclusive ? remainingKm : null,
    reached,
    conclusive,
    inconclusiveReason: stale ? "ODOMETER_STALE" : null,
  };
}

function evaluateTime(lastService: ServiceRecordInput, intervalMonths: number, asOfDate: IsoLocalDate): DimensionOutcome {
  const limitDate = addMonthsClamped(lastService.performedOn, intervalMonths);
  const remainingDays = daysBetween(asOfDate, limitDate);
  return {
    dimension: "TIME",
    limitKm: null,
    limitDate,
    remaining: remainingDays,
    reached: remainingDays <= 0,
    conclusive: true,
    inconclusiveReason: null,
  };
}

function classifyCommunication(
  technicalStatus: "DUE" | "NOT_DUE",
  dimensions: DimensionOutcome[],
  { communication: policy }: EvaluationPolicies,
): { assessment: CommunicationAssessment; reasons: ReasonCode[] } {
  const concluded = dimensions.filter((d) => d.conclusive && d.remaining !== null);

  if (technicalStatus === "DUE") {
    const reached = concluded.filter((d) => d.reached);
    const graceExceeded = reached.filter(
      (d) => -(d.remaining as number) >= (d.dimension === "KM" ? policy.overdueGraceKm : policy.overdueGraceDays),
    );
    if (graceExceeded.length > 0) {
      return {
        assessment: { status: "OVERDUE", policyVersion: policy.policyVersion, triggeredBy: dimensionOf(graceExceeded) },
        reasons: graceExceeded.map((d) => (d.dimension === "KM" ? "KM_GRACE_EXCEEDED" : "TIME_GRACE_EXCEEDED")),
      };
    }
    return {
      assessment: { status: "DUE", policyVersion: policy.policyVersion, triggeredBy: dimensionOf(reached) },
      reasons: [],
    };
  }

  const withinLead = concluded.filter(
    (d) => (d.remaining as number) <= (d.dimension === "KM" ? policy.leadKm : policy.leadDays),
  );
  if (withinLead.length > 0) {
    return {
      assessment: { status: "UPCOMING", policyVersion: policy.policyVersion, triggeredBy: dimensionOf(withinLead) },
      reasons: withinLead.map((d) => (d.dimension === "KM" ? "KM_WITHIN_LEAD" : "TIME_WITHIN_LEAD")),
    };
  }
  return { assessment: { status: "NOT_DUE", policyVersion: policy.policyVersion, triggeredBy: null }, reasons: [] };
}

// ───────────────────────────── Utilidades ─────────────────────────────

function dimensionOf(dims: ReadonlyArray<{ dimension: "KM" | "TIME" }>): Dimension | null {
  const hasKm = dims.some((d) => d.dimension === "KM");
  const hasTime = dims.some((d) => d.dimension === "TIME");
  if (hasKm && hasTime) return "BOTH";
  if (hasKm) return "KM";
  if (hasTime) return "TIME";
  return null;
}

function describe(d: DimensionOutcome): string {
  if (!d.conclusive) return `INCONCLUSIVE:${d.inconclusiveReason}`;
  return d.reached ? "LIMIT_REACHED" : "WITHIN_LIMIT";
}

function collectDataOrigin(input: EvaluationInput, policies: EvaluationPolicies): EvaluationResult["dataOrigin"] {
  const sources: string[] = [];
  if (input.plan?.dataOrigin === "SYNTHETIC") sources.push(`plan:${input.plan.planVersionId} (${input.plan.sourceRef})`);
  if (input.lastService?.dataOrigin === "SYNTHETIC") sources.push(`serviceRecord:${input.lastService.recordId}`);
  if (input.odometer?.dataOrigin === "SYNTHETIC") sources.push(`odometerReading:${input.odometer.readingId}`);
  if (policies.communication.dataOrigin === "SYNTHETIC") {
    sources.push(`communicationPolicy:${policies.communication.policyVersion}`);
  }
  return { containsSyntheticData: sources.length > 0, syntheticSources: sources };
}

const isNonNegativeInt = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0;
const isPositiveIntOrNull = (n: unknown): boolean => n === null || (Number.isInteger(n) && (n as number) > 0);
const isIsoInstant = (s: unknown): boolean =>
  typeof s === "string" && ISO_INSTANT_RE.test(s) && !Number.isNaN(Date.parse(s));

function validate(input: EvaluationInput, policies: EvaluationPolicies): string[] {
  const issues: string[] = [];
  const { communication: c, dataQuality: q } = policies;
  for (const [name, value] of Object.entries({
    leadKm: c.leadKm,
    leadDays: c.leadDays,
    overdueGraceKm: c.overdueGraceKm,
    overdueGraceDays: c.overdueGraceDays,
    maxOdometerAgeDays: q.maxOdometerAgeDays,
  })) {
    if (!isNonNegativeInt(value)) issues.push(`policy.${name}`);
  }

  if (input.plan) {
    const synthetic = input.plan.dataOrigin === "SYNTHETIC";
    if (synthetic !== input.plan.sourceRef.startsWith(SYNTHETIC_SOURCE_PREFIX)) issues.push("plan.sourceRef.syntheticLabel");
    input.plan.rules.forEach((r, i) => {
      if (!isPositiveIntOrNull(r.intervalKm)) issues.push(`plan.rules[${i}].intervalKm`);
      if (!isPositiveIntOrNull(r.intervalMonths)) issues.push(`plan.rules[${i}].intervalMonths`);
    });
  }

  const svc = input.lastService;
  if (svc) {
    if (svc.serviceCode !== input.serviceCode) issues.push("lastService.serviceCode");
    if (!isValidLocalDate(svc.performedOn)) issues.push("lastService.performedOn");
    if (!isNonNegativeInt(svc.odometerKm)) issues.push("lastService.odometerKm");
  }
  if (input.odometer) {
    if (!isNonNegativeInt(input.odometer.valueKm)) issues.push("odometer.valueKm");
    if (!isIsoInstant(input.odometer.observedAt)) issues.push("odometer.observedAt");
  }
  input.odometerHistory.forEach((r, i) => {
    if (!isNonNegativeInt(r.valueKm)) issues.push(`odometerHistory[${i}].valueKm`);
    if (!isIsoInstant(r.observedAt)) issues.push(`odometerHistory[${i}].observedAt`);
  });
  return issues;
}
