import type { ActorContext } from "@/domain/policies/access-policy";
import { daysBetween, toLocalDate } from "@/domain/shared/local-date";
import { ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { AppError } from "./errors";
import { authorizeVehicleAccess } from "./vehicle-access";

export interface VehicleProfile {
  vehicleId: string;
  vehicleAlias: string;
  plateMasked: string | null;
  spec: {
    make: string;
    model: string;
    modelYear: number;
    engineCode: string | null;
    fuelType: string;
    timingDrive: "BELT" | "CHAIN" | "UNKNOWN";
    specVerified: boolean;
  };
  odometer: null | {
    valueKm: number;
    observedAt: string;
    provenance: string;
    verification: string;
    dataOrigin: "REAL" | "SYNTHETIC";
    ageDays: number;
  };
  deliveredAt: string | null;
  usageCondition: "NORMAL" | "SEVERE" | null;
  dataOrigin: "REAL" | "SYNTHETIC";
  syntheticSourceRef: string | null;
}

/**
 * Perfil del vehículo para el titular (AGENT_DESIGN.md §3.2 `getVehicleProfile`).
 * Minimiza datos: sin VIN, sin placa completa y sin datos personales del propietario.
 */
export async function getVehicleProfile(
  { db, clock }: { db: Db; clock: Clock },
  { actor, vehicleId }: { actor: ActorContext; vehicleId: string },
): Promise<Result<VehicleProfile, AppError>> {
  const now = clock.now();
  const access = await authorizeVehicleAccess(db, actor, vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;

  const v = await db.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    include: {
      spec: true,
      odometerReadings: { where: { verification: { not: "REJECTED" } }, orderBy: { observedAt: "desc" }, take: 1 },
    },
  });
  const reading = v.odometerReadings[0];

  return ok({
    vehicleId: v.id,
    vehicleAlias: `${v.spec.model} ${v.spec.modelYear}`,
    plateMasked: v.plate ? maskPlate(v.plate) : null,
    spec: {
      make: v.spec.make,
      model: v.spec.model,
      modelYear: v.spec.modelYear,
      engineCode: v.spec.engineCode,
      fuelType: v.spec.fuelType,
      timingDrive: v.spec.timingDrive,
      specVerified: v.spec.verifiedAt !== null,
    },
    odometer: reading
      ? {
          valueKm: reading.valueKm,
          observedAt: reading.observedAt.toISOString(),
          provenance: reading.provenance,
          verification: reading.verification,
          dataOrigin: reading.dataOrigin,
          ageDays: daysBetween(toLocalDate(reading.observedAt), toLocalDate(now)),
        }
      : null,
    deliveredAt: v.deliveredAt?.toISOString() ?? null,
    usageCondition: v.usageCondition,
    dataOrigin: v.dataOrigin,
    syntheticSourceRef: v.syntheticSourceRef,
  });
}

/** Deja visibles solo los dos últimos caracteres: "DMO001" → "••••01". */
export function maskPlate(plate: string): string {
  const visible = plate.slice(-2);
  return "•".repeat(Math.max(plate.length - visible.length, 0)) + visible;
}
