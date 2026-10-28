import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { appError, type AppError } from "./errors";
import { selectPlanVersion } from "./evaluation-context-builder";
import { authorizeVehicleAccess } from "./vehicle-access";

export interface MaintenancePlanView {
  planVersionId: string;
  version: string;
  status: "VALIDATED";
  sourceRef: string;
  dataOrigin: "REAL" | "SYNTHETIC";
  rules: Array<{ serviceCode: string; intervalKm: number | null; intervalMonths: number | null; appliesToTimingDrive: "BELT" | "CHAIN" | null; usageCondition: string | null }>;
}

/**
 * Plan técnico aplicable al vehículo (AGENT_DESIGN.md `getMaintenancePlan`). Solo expone planes VALIDATED:
 * sin plan validado responde PLAN_NOT_VERIFIED y no entrega intervalos (AC03).
 */
export async function getMaintenancePlan(
  { db, clock }: { db: Db; clock: Clock },
  { actor, vehicleId }: { actor: ActorContext; vehicleId: string },
): Promise<Result<MaintenancePlanView, AppError>> {
  const now = clock.now();
  const access = await authorizeVehicleAccess(db, actor, vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;
  const vehicle = await db.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    include: { spec: { include: { planLinks: { include: { plan: { include: { versions: { include: { rules: true } } } } } } } } },
  });
  const plans = vehicle.spec.planLinks.map((l) => l.plan);
  if (plans.length !== 1) return err(appError(plans.length === 0 ? "PLAN_NOT_VERIFIED" : "AMBIGUOUS_PLAN"));
  const version = selectPlanVersion(plans[0].versions, now);
  if (!version || version.status !== "VALIDATED") return err(appError("PLAN_NOT_VERIFIED"));
  return ok({
    planVersionId: version.id,
    version: version.version,
    status: "VALIDATED",
    sourceRef: version.sourceRef,
    dataOrigin: version.dataOrigin,
    rules: version.rules
      .map((r) => ({
        serviceCode: r.serviceCode,
        intervalKm: r.intervalKm,
        intervalMonths: r.intervalMonths,
        appliesToTimingDrive: r.appliesToTimingDrive === "UNKNOWN" ? null : r.appliesToTimingDrive,
        usageCondition: r.usageCondition,
      }))
      .sort((a, b) => a.serviceCode.localeCompare(b.serviceCode)),
  });
}
