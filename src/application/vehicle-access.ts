import {
  decideVehicleAccess,
  type ActorContext,
  type VehicleAction,
  type VehicleAccessFacts,
} from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Db } from "@/infra/prisma";
import { appError, type AppError } from "./errors";

/**
 * Carga los hechos de titularidad y talleres del vehículo y aplica la política de acceso.
 * Un vehículo inexistente responde igual que uno ajeno (UNAUTHORIZED) para no revelar su existencia.
 */
export async function authorizeVehicleAccess(
  db: Db,
  actor: ActorContext,
  vehicleId: string,
  action: VehicleAction,
  now: Date,
): Promise<Result<void, AppError>> {
  const vehicle = await db.vehicle.findUnique({
    where: { id: vehicleId },
    select: {
      ownerships: { select: { customerId: true, validFrom: true, validTo: true } },
      workOrders: { select: { booking: { select: { workshopId: true } } } },
      serviceRecords: { select: { workshopId: true } },
    },
  });
  if (!vehicle) return err(appError("UNAUTHORIZED", "NO_ACTIVE_OWNERSHIP"));

  const workshopIds = new Set<string>();
  for (const wo of vehicle.workOrders) if (wo.booking?.workshopId) workshopIds.add(wo.booking.workshopId);
  for (const sr of vehicle.serviceRecords) if (sr.workshopId) workshopIds.add(sr.workshopId);

  const facts: VehicleAccessFacts = { ownerships: vehicle.ownerships, workshopIdsWithWorkOrders: [...workshopIds] };
  const decision = decideVehicleAccess(actor, action, facts, now);
  return decision.allowed ? ok(undefined) : err(appError("UNAUTHORIZED", decision.detail));
}
