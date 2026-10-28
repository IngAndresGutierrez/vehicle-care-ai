import type { DueStatus } from "@/domain/maintenance-engine";
import type { ActorContext } from "@/domain/policies/access-policy";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { dispatchMaintenanceReminder, type ReminderOutcome } from "./dispatch-maintenance-reminder";
import type { AppError } from "./errors";
import { evaluateVehicle } from "./evaluate-vehicle";

/** Servicio P0 del MVP: se evalúa aunque el vehículo no tenga plan (resultado PLAN_MISSING trazable). */
export const P0_SERVICE_CODES = ["ENGINE_OIL_FILTER"] as const;

export interface JobItem {
  vehicleId: string;
  serviceCode: string;
  evaluation: { evaluationId: string; status: DueStatus } | { error: AppError };
  reminder?: ReminderOutcome | { error: AppError };
}

/**
 * Job de evaluación (ARCHITECTURE.md §4.1): para cada vehículo con titular vigente evalúa los servicios
 * de su plan y registra el recordatorio o su supresión. La transición del journey llega en la Fase 3.
 */
export async function runEvaluationJob(
  deps: { db: Db; clock: Clock },
  { actor, traceId }: { actor: ActorContext; traceId: string },
): Promise<JobItem[]> {
  const now = deps.clock.now();
  const vehicles = await deps.db.vehicle.findMany({
    where: { ownerships: { some: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } } },
    select: {
      id: true,
      spec: { select: { planLinks: { select: { plan: { select: { versions: { select: { rules: { select: { serviceCode: true } } } } } } } } } },
    },
    orderBy: { id: "asc" },
  });

  const items: JobItem[] = [];
  for (const vehicle of vehicles) {
    const fromPlans = vehicle.spec.planLinks.flatMap((l) => l.plan.versions.flatMap((v) => v.rules.map((r) => r.serviceCode)));
    const serviceCodes = [...new Set(fromPlans.length > 0 ? fromPlans : P0_SERVICE_CODES)].sort();

    for (const serviceCode of serviceCodes) {
      const evaluated = await evaluateVehicle(deps, { actor, vehicleId: vehicle.id, serviceCode, traceId });
      if (!evaluated.ok) {
        items.push({ vehicleId: vehicle.id, serviceCode, evaluation: { error: evaluated.error } });
        continue;
      }
      const reminder = await dispatchMaintenanceReminder(deps, { evaluationId: evaluated.value.evaluationId, traceId });
      items.push({
        vehicleId: vehicle.id,
        serviceCode,
        evaluation: { evaluationId: evaluated.value.evaluationId, status: evaluated.value.result.status },
        reminder: reminder.ok ? reminder.value : { error: reminder.error },
      });
    }
  }
  return items;
}
