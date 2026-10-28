import {
  decideVehicleAccess,
  type ActorContext,
  type VehicleAction,
  type VehicleAccessFacts,
} from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Db } from "@/infra/prisma";
import { appError, type AppError } from "./errors";
import type { Tx } from "./transaction";

/** Carga titularidad, talleres, cartera de asesores y casos abiertos del vehículo para la política de acceso. */
export async function loadVehicleAccessFacts(db: Db | Tx, vehicleId: string): Promise<VehicleAccessFacts | null> {
  const vehicle = await db.vehicle.findUnique({
    where: { id: vehicleId },
    select: {
      ownerships: {
        select: {
          customerId: true,
          validFrom: true,
          validTo: true,
          customer: { select: { portfolioAssignments: { select: { actorId: true, customerId: true, validFrom: true, validTo: true } } } },
        },
      },
      workOrders: { select: { booking: { select: { workshopId: true } } } },
      serviceRecords: { select: { workshopId: true } },
      humanCases: { where: { status: { in: ["OPEN", "ASSIGNED"] } }, select: { assigneeId: true } },
    },
  });
  if (!vehicle) return null;

  const workshopIds = new Set<string>();
  for (const wo of vehicle.workOrders) if (wo.booking?.workshopId) workshopIds.add(wo.booking.workshopId);
  for (const sr of vehicle.serviceRecords) if (sr.workshopId) workshopIds.add(sr.workshopId);

  return {
    ownerships: vehicle.ownerships.map(({ customerId, validFrom, validTo }) => ({ customerId, validFrom, validTo })),
    workshopIdsWithWorkOrders: [...workshopIds],
    portfolioAssignments: vehicle.ownerships.flatMap((o) => o.customer.portfolioAssignments),
    openCaseAssigneeIds: vehicle.humanCases.flatMap((c) => (c.assigneeId ? [c.assigneeId] : [])),
  };
}

/**
 * Aplica la política de acceso (denegación por defecto). Un vehículo inexistente responde igual que uno
 * ajeno (UNAUTHORIZED) para no revelar su existencia.
 */
export async function authorizeVehicleAccess(
  db: Db | Tx,
  actor: ActorContext,
  vehicleId: string,
  action: VehicleAction,
  now: Date,
  options: { justification?: string } = {},
): Promise<Result<void, AppError>> {
  const facts = await loadVehicleAccessFacts(db, vehicleId);
  if (!facts) return err(appError("UNAUTHORIZED", "NO_ACTIVE_OWNERSHIP"));
  const decision = decideVehicleAccess(actor, action, facts, now, options);
  return decision.allowed ? ok(undefined) : err(appError("UNAUTHORIZED", decision.detail));
}
