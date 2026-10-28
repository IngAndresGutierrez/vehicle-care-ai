import type { ActorContext } from "@/domain/policies/access-policy";
import { ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { AppError } from "./errors";
import { toIsoLocalDate } from "./evaluation-context-builder";
import { authorizeVehicleAccess } from "./vehicle-access";

export interface ServiceHistory {
  serviceRecords: Array<{
    recordId: string;
    serviceCode: string;
    performedOn: string;
    odometerKm: number;
    provenance: string;
    dataOrigin: "REAL" | "SYNTHETIC";
    syntheticSourceRef: string | null;
    evidenceAvailable: boolean;
    supersedesId: string | null;
  }>;
  odometerReadings: Array<{
    readingId: string;
    valueKm: number;
    observedAt: string;
    provenance: string;
    verification: string;
    dataOrigin: "REAL" | "SYNTHETIC";
    syntheticSourceRef: string | null;
  }>;
}

/**
 * Historial con procedencia y origen explícitos (AC11, ADR-011): distingue lo acreditado por el taller,
 * lo declarado por el cliente y lo sintético.
 */
export async function getServiceHistory(
  { db, clock }: { db: Db; clock: Clock },
  { actor, vehicleId, serviceCode }: { actor: ActorContext; vehicleId: string; serviceCode?: string },
): Promise<Result<ServiceHistory, AppError>> {
  const access = await authorizeVehicleAccess(db, actor, vehicleId, "READ_VEHICLE", clock.now());
  if (!access.ok) return access;

  const [services, readings] = await Promise.all([
    db.serviceRecord.findMany({
      where: { vehicleId, ...(serviceCode ? { serviceCode } : {}) },
      orderBy: [{ performedOn: "desc" }, { createdAt: "desc" }],
    }),
    db.odometerReading.findMany({ where: { vehicleId }, orderBy: { observedAt: "desc" } }),
  ]);

  return ok({
    serviceRecords: services.map((r) => ({
      recordId: r.id,
      serviceCode: r.serviceCode,
      performedOn: toIsoLocalDate(r.performedOn),
      odometerKm: r.odometerKm,
      provenance: r.provenance,
      dataOrigin: r.dataOrigin,
      syntheticSourceRef: r.syntheticSourceRef,
      evidenceAvailable: r.evidenceRef !== null || r.workOrderId !== null,
      supersedesId: r.supersedesId,
    })),
    odometerReadings: readings.map((r) => ({
      readingId: r.id,
      valueKm: r.valueKm,
      observedAt: r.observedAt.toISOString(),
      provenance: r.provenance,
      verification: r.verification,
      dataOrigin: r.dataOrigin,
      syntheticSourceRef: r.syntheticSourceRef,
    })),
  });
}
