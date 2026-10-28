import type {
  EvaluationInput,
  EvaluationPolicies,
  MaintenanceRuleInput,
  PlanVersionInput,
} from "@/domain/maintenance-engine";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Db } from "@/infra/prisma";
import { appError, type AppError } from "./errors";

export interface EvaluationContext {
  input: EvaluationInput;
  policies: EvaluationPolicies;
}

/**
 * Traduce los registros de PostgreSQL al `EvaluationInput` del motor (ARCHITECTURE.md §4.1).
 *
 * Solo selecciona y mapea datos; no calcula vencimientos ni decide estados. Reglas de selección:
 * - Plan: el aplicable a la especificación del vehículo; de él, la versión VALIDATED vigente más reciente o,
 *   si no hay, la última versión en cualquier estado (el motor responderá PLAN_NOT_VERIFIED).
 * - Último servicio: el registro más reciente del `serviceCode` que no haya sido reemplazado (`supersedesId`).
 * - Odómetro: lecturas no rechazadas ni reemplazadas; la más reciente es `odometer`, el resto `odometerHistory`.
 */
export async function buildEvaluationContext(
  db: Db,
  vehicleId: string,
  serviceCode: string,
  now: Date,
): Promise<Result<EvaluationContext, AppError>> {
  const vehicle = await db.vehicle.findUnique({
    where: { id: vehicleId },
    include: {
      spec: {
        include: {
          planLinks: { include: { plan: { include: { versions: { include: { rules: true } } } } } },
        },
      },
      serviceRecords: { where: { serviceCode } },
      odometerReadings: true,
    },
  });
  if (!vehicle) return err(appError("VEHICLE_NOT_FOUND"));

  const [communication, dataQuality] = await Promise.all([
    db.communicationPolicy.findFirst({ where: { isActive: true } }),
    db.dataQualityPolicy.findFirst({ where: { isActive: true } }),
  ]);
  if (!communication || !dataQuality) return err(appError("POLICY_MISSING"));

  const plans = vehicle.spec.planLinks.map((link) => link.plan);
  if (plans.length > 1) return err(appError("AMBIGUOUS_PLAN", plans.map((p) => p.id).join(",")));
  const planVersion = plans[0] ? selectPlanVersion(plans[0].versions, now) : null;

  const supersededServices = new Set(vehicle.serviceRecords.map((r) => r.supersedesId).filter(Boolean));
  const lastService =
    vehicle.serviceRecords
      .filter((r) => !supersededServices.has(r.id))
      .sort(
        (a, b) =>
          b.performedOn.getTime() - a.performedOn.getTime() ||
          b.odometerKm - a.odometerKm ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      )[0] ?? null;

  const supersededReadings = new Set(vehicle.odometerReadings.map((r) => r.supersedesId).filter(Boolean));
  const readings = vehicle.odometerReadings
    .filter((r) => r.verification !== "REJECTED" && !supersededReadings.has(r.id))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  const latestReading = readings.at(-1) ?? null;

  const input: EvaluationInput = {
    vehicleId: vehicle.id,
    serviceCode,
    spec: {
      engineCode: vehicle.spec.engineCode,
      timingDrive: vehicle.spec.timingDrive,
      market: vehicle.spec.market,
    },
    plan: planVersion ? toPlanInput(planVersion) : null,
    usageCondition: vehicle.usageCondition,
    lastService: lastService && {
      recordId: lastService.id,
      serviceCode: lastService.serviceCode,
      performedOn: toIsoLocalDate(lastService.performedOn),
      odometerKm: lastService.odometerKm,
      provenance: lastService.provenance,
      dataOrigin: lastService.dataOrigin,
    },
    odometer: latestReading && {
      readingId: latestReading.id,
      valueKm: latestReading.valueKm,
      observedAt: latestReading.observedAt.toISOString(),
      provenance: latestReading.provenance,
      dataOrigin: latestReading.dataOrigin,
    },
    odometerHistory: readings.slice(0, -1).map((r) => ({ valueKm: r.valueKm, observedAt: r.observedAt.toISOString() })),
  };

  const policies: EvaluationPolicies = {
    communication: {
      policyVersion: communication.version,
      dataOrigin: communication.dataOrigin,
      leadKm: communication.leadKm,
      leadDays: communication.leadDays,
      overdueGraceKm: communication.overdueGraceKm,
      overdueGraceDays: communication.overdueGraceDays,
    },
    dataQuality: { policyVersion: dataQuality.version, maxOdometerAgeDays: dataQuality.maxOdometerAgeDays },
  };

  return ok({ input, policies });
}

export type DbPlanVersion = {
  id: string;
  version: string;
  status: "DRAFT" | "VALIDATED" | "RETIRED";
  sourceRef: string;
  dataOrigin: "REAL" | "SYNTHETIC";
  effectiveFrom: Date | null;
  createdAt: Date;
  rules: Array<{
    id: string;
    serviceCode: string;
    intervalKm: number | null;
    intervalMonths: number | null;
    appliesToTimingDrive: "BELT" | "CHAIN" | "UNKNOWN" | null;
    usageCondition: "NORMAL" | "SEVERE" | null;
    requiresUsageCondition: boolean;
    allowDeliveryBaseline: boolean;
  }>;
};

export function selectPlanVersion(versions: DbPlanVersion[], now: Date): DbPlanVersion | null {
  const newestFirst = [...versions].sort(
    (a, b) =>
      (b.effectiveFrom?.getTime() ?? 0) - (a.effectiveFrom?.getTime() ?? 0) || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const validated = newestFirst.find(
    (v) => v.status === "VALIDATED" && (v.effectiveFrom === null || v.effectiveFrom.getTime() <= now.getTime()),
  );
  return validated ?? newestFirst[0] ?? null;
}

function toPlanInput(v: DbPlanVersion): PlanVersionInput {
  return {
    planVersionId: v.id,
    version: v.version,
    status: v.status,
    sourceRef: v.sourceRef,
    dataOrigin: v.dataOrigin,
    rules: v.rules
      .map(
        (r): MaintenanceRuleInput => ({
          ruleId: r.id,
          serviceCode: r.serviceCode,
          intervalKm: r.intervalKm,
          intervalMonths: r.intervalMonths,
          appliesToTimingDrive: ruleTimingScope(r.id, r.appliesToTimingDrive),
          usageCondition: r.usageCondition,
          requiresUsageCondition: r.requiresUsageCondition,
          allowDeliveryBaseline: r.allowDeliveryBaseline,
        }),
      )
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
  };
}

/** La BD lo impide (CHECK `MaintenanceRule_timing_scope`); si aparece, es corrupción de datos, no un caso de negocio. */
function ruleTimingScope(ruleId: string, scope: "BELT" | "CHAIN" | "UNKNOWN" | null): "BELT" | "CHAIN" | null {
  if (scope === "UNKNOWN") throw new Error(`MaintenanceRule ${ruleId}: appliesToTimingDrive=UNKNOWN no es válido`);
  return scope;
}

/** `@db.Date` llega como medianoche UTC; su parte de fecha es la fecha de calendario almacenada. */
export function toIsoLocalDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
