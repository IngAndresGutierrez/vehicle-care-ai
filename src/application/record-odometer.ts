import { createHash } from "node:crypto";
import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { audit, journeyErrorToApp } from "./booking/common";
import { appError, type AppError } from "./errors";
import { applyJourneyEventInTx } from "./journey/journey-store";
import { runInTransaction, type Tx } from "./transaction";
import { authorizeVehicleAccess } from "./vehicle-access";

export const MAX_ODOMETER_KM = 2_000_000;
/** Tolerancia de reloj para lecturas «ahora» enviadas por el cliente. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export interface RecordedOdometer {
  readingId: string;
  valueKm: number;
  provenance: "OWNER_DECLARED" | "WORKSHOP_VERIFIED";
  verification: "UNVERIFIED" | "VERIFIED";
  journeysUpdated: string[];
  duplicate: boolean;
}

/**
 * Registra una lectura de odómetro con procedencia (AGENT_DESIGN.md `recordOdometer`). Lo declarado por el
 * propietario (o por el asesor en su nombre) queda UNVERIFIED; lo registrado por el taller, VERIFIED.
 * Rechaza retrocesos frente a la última lectura verificada (fraude o error). Si un journey del vehículo está en
 * conversación, aplica ODOMETER_RECORDED; la re-evaluación la dispara quien conduce la conversación.
 */
export async function recordOdometer(
  { db, clock }: { db: Db; clock: Clock },
  cmd: { actor: ActorContext; vehicleId: string; valueKm: number; observedAt?: Date; traceId: string; idempotencyKey: string },
): Promise<Result<RecordedOdometer, AppError>> {
  const now = clock.now();
  if (!Number.isInteger(cmd.valueKm) || cmd.valueKm < 0 || cmd.valueKm > MAX_ODOMETER_KM) return err(appError("INVALID_INPUT", "VALUE_KM"));
  const observedAt = cmd.observedAt ?? now;
  if (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return err(appError("INVALID_INPUT", "OBSERVED_AT"));
  if (cmd.actor.role === "SYSTEM_JOB" || cmd.actor.role === "COMPLIANCE") return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  const access = await authorizeVehicleAccess(db, cmd.actor, cmd.vehicleId, "READ_VEHICLE", now);
  if (!access.ok) return access;

  const workshop = cmd.actor.role === "WORKSHOP_COORDINATOR" || cmd.actor.role === "TECHNICIAN";
  const readingId = `odo_${createHash("sha256").update(`${cmd.vehicleId}:${cmd.idempotencyKey}`).digest("hex").slice(0, 24)}`;

  return runInTransaction<RecordedOdometer, AppError>(db, async (tx) => {
    const existing = await tx.odometerReading.findUnique({ where: { id: readingId } });
    if (existing) {
      if (existing.valueKm !== cmd.valueKm || existing.vehicleId !== cmd.vehicleId) return err(appError("IDEMPOTENCY_MISMATCH"));
      return ok({ readingId, valueKm: existing.valueKm, provenance: existing.provenance as RecordedOdometer["provenance"], verification: existing.verification as RecordedOdometer["verification"], journeysUpdated: [], duplicate: true });
    }
    const vehicle = await lockVehicle(tx, cmd.vehicleId);
    const lastVerified = await tx.odometerReading.findFirst({
      where: { vehicleId: cmd.vehicleId, verification: "VERIFIED" },
      orderBy: { valueKm: "desc" },
    });
    if (lastVerified && cmd.valueKm < lastVerified.valueKm) {
      return err(appError("ODOMETER_ROLLBACK", undefined, { refs: { lastVerifiedKm: String(lastVerified.valueKm) } }));
    }

    const synthetic = vehicle.dataOrigin === "SYNTHETIC";
    await tx.odometerReading.create({
      data: {
        id: readingId,
        vehicleId: cmd.vehicleId,
        valueKm: cmd.valueKm,
        observedAt,
        provenance: workshop ? "WORKSHOP_VERIFIED" : "OWNER_DECLARED",
        verification: workshop ? "VERIFIED" : "UNVERIFIED",
        recordedById: cmd.actor.actorId,
        traceId: cmd.traceId,
        dataOrigin: vehicle.dataOrigin,
        syntheticSourceRef: synthetic ? `SYNTHETIC-DEMO:reading-on-synthetic-vehicle/${cmd.vehicleId}` : null,
        createdAt: now,
      },
    });

    const journeys = await tx.journeyInstance.findMany({ where: { vehicleId: cmd.vehicleId, state: { in: ["CONVERSATION_OPEN", "AWAITING_CONTEXT"] } } });
    const updated: string[] = [];
    for (const j of journeys) {
      const applied = await applyJourneyEventInTx(tx, {
        vehicleId: cmd.vehicleId,
        serviceCode: j.serviceCode,
        event: { type: "ODOMETER_RECORDED", readingId },
        actor: { actorId: cmd.actor.actorId, role: cmd.actor.role },
        traceId: cmd.traceId,
        idempotencyKey: `odometer:${readingId}:${j.serviceCode}`,
      });
      if (!applied.ok) return err(journeyErrorToApp(applied.error));
      updated.push(j.id);
    }
    await audit(tx, { actor: cmd.actor, action: "ODOMETER_RECORDED", entityType: "OdometerReading", entityId: readingId, details: { valueKm: cmd.valueKm, verified: workshop }, traceId: cmd.traceId, at: now });
    return ok({ readingId, valueKm: cmd.valueKm, provenance: workshop ? "WORKSHOP_VERIFIED" : "OWNER_DECLARED", verification: workshop ? "VERIFIED" : "UNVERIFIED", journeysUpdated: updated, duplicate: false });
  });
}

/** Serializa los registros de odómetro de un vehículo (evita que dos lecturas concurrentes eludan el control de retroceso). */
export async function lockVehicle(tx: Tx, vehicleId: string): Promise<{ id: string; dataOrigin: "REAL" | "SYNTHETIC" }> {
  const rows = await tx.$queryRaw<Array<{ id: string; dataOrigin: "REAL" | "SYNTHETIC" }>>`
    SELECT "id", "dataOrigin"::text AS "dataOrigin" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
  if (rows.length !== 1) throw new Error(`Vehículo ${vehicleId} inexistente`);
  return rows[0];
}
