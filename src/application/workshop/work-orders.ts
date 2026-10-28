import type { JourneyState } from "@/domain/journey";
import type { DueStatus } from "@/domain/maintenance-engine";
import type { ActorContext } from "@/domain/policies/access-policy";
import { toLocalDate } from "@/domain/shared/local-date";
import { err, ok, type Result } from "@/domain/shared/result";
import { activeOwnerId, audit, journeyErrorToApp, precheckJourney, workshopErrorToApp, type BookingDeps } from "../booking/common";
import { appError, type AppError } from "../errors";
import { evaluateVehicle } from "../evaluate-vehicle";
import { applyJourneyEvent, applyJourneyEventInTx } from "../journey/journey-store";
import { lockVehicle } from "../record-odometer";
import { runInTransaction } from "../transaction";

const WORKSHOP_ROLES = new Set<ActorContext["role"]>(["WORKSHOP_COORDINATOR", "TECHNICIAN"]);

/** Actor de sistema que re-evalúa tras el cierre del taller (hecho de sistema, no decisión humana). */
export const POST_SERVICE_EVALUATOR: ActorContext = { actorId: "system:post-service-evaluation", role: "SYSTEM_JOB", customerId: null, workshopId: null };

function authorizeWorkshopActor(actor: ActorContext, workshopId: string): Result<void, AppError> {
  if (!WORKSHOP_ROLES.has(actor.role)) return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  if (actor.workshopId !== workshopId) return err(appError("UNAUTHORIZED", "OTHER_WORKSHOP"));
  return ok(undefined);
}

/** Recepción del vehículo en el taller: abre la OT en el taller (MOCK) y lleva el journey a IN_SERVICE. */
export async function openWorkOrder(
  deps: BookingDeps,
  cmd: { actor: ActorContext; bookingId: string; traceId: string },
): Promise<Result<{ workOrderId: string; workOrderRef: string; journeyState: JourneyState; duplicate: boolean }, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  const booking = await db.booking.findUnique({ where: { id: cmd.bookingId }, include: { workOrder: true } });
  if (!booking) return err(appError("NOT_FOUND"));
  const auth = authorizeWorkshopActor(cmd.actor, booking.workshopId);
  if (!auth.ok) return auth;
  if (booking.workOrder) return ok({ workOrderId: booking.workOrder.id, workOrderRef: booking.workOrder.externalRef ?? "", journeyState: "IN_SERVICE", duplicate: true });
  if (booking.status !== "CONFIRMED" || !booking.externalBookingRef) return err(appError("WORK_ORDER_STATE", `BOOKING_${booking.status}`));

  const key = { vehicleId: booking.vehicleId, serviceCode: booking.serviceCode };
  const pre = await precheckJourney(db, key, { type: "WORK_ORDER_OPENED", workOrderId: "precheck" }, { actorId: cmd.actor.actorId, role: cmd.actor.role });
  if (!pre.ok) return pre;

  const opened = await workshop.openWorkOrder(booking.externalBookingRef);
  if (!opened.ok) return err(workshopErrorToApp(opened.error));

  return runInTransaction(db, async (tx) => {
    const wo = await tx.workOrder.create({
      data: {
        vehicleId: booking.vehicleId,
        bookingId: booking.id,
        externalRef: opened.data.workOrderRef,
        status: "IN_PROGRESS",
        dataOrigin: "SYNTHETIC",
        syntheticSourceRef: `SYNTHETIC-DEMO:mock-workshop/${opened.data.workOrderRef}`,
      },
    });
    const applied = await applyJourneyEventInTx(tx, { ...key, event: { type: "WORK_ORDER_OPENED", workOrderId: wo.id }, actor: { actorId: cmd.actor.actorId, role: cmd.actor.role }, traceId: cmd.traceId, idempotencyKey: `wo-opened:${booking.id}` });
    if (!applied.ok) return err(journeyErrorToApp(applied.error));
    await audit(tx, { actor: cmd.actor, action: "WORK_ORDER_OPENED", entityType: "WorkOrder", entityId: wo.id, details: { bookingId: booking.id, workOrderRef: opened.data.workOrderRef, source: opened.source }, traceId: cmd.traceId, at: now });
    return ok({ workOrderId: wo.id, workOrderRef: opened.data.workOrderRef, journeyState: applied.value.to, duplicate: false });
  });
}

export interface CompletedWorkOrder {
  workOrderId: string;
  serviceRecordId: string;
  odometerReadingId: string;
  journeyState: JourneyState;
  reevaluation: { evaluationId: string; status: DueStatus } | null;
  duplicate: boolean;
}

/**
 * Cierre de la OT: operación **exclusiva del personal del taller** asignado a la reserva. Registra el servicio y
 * el odómetro como WORKSHOP_VERIFIED (origen SYNTHETIC porque el taller es MOCK, ADR-011/D-09), lleva el journey
 * a SERVICE_COMPLETED y, tras el commit, re-evalúa el plan (REEVALUATED → FOLLOW_UP).
 */
export async function completeWorkOrder(
  deps: BookingDeps,
  cmd: { actor: ActorContext; workOrderId: string; completionOdometerKm: number; traceId: string },
): Promise<Result<CompletedWorkOrder, AppError>> {
  const { db, clock, workshop } = deps;
  const now = clock.now();
  if (!WORKSHOP_ROLES.has(cmd.actor.role)) return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  if (!Number.isInteger(cmd.completionOdometerKm) || cmd.completionOdometerKm < 0) return err(appError("INVALID_INPUT", "COMPLETION_ODOMETER"));

  const wo = await db.workOrder.findUnique({ where: { id: cmd.workOrderId }, include: { booking: true, serviceRecord: true } });
  if (!wo || !wo.booking) return err(appError("NOT_FOUND"));
  const auth = authorizeWorkshopActor(cmd.actor, wo.booking.workshopId);
  if (!auth.ok) return auth;
  if (wo.status === "COMPLETED" && wo.serviceRecord) {
    if (wo.completionOdometerKm !== cmd.completionOdometerKm) return err(appError("WORK_ORDER_STATE", "ALREADY_COMPLETED"));
    return ok({ workOrderId: wo.id, serviceRecordId: wo.serviceRecord.id, odometerReadingId: `odo-${wo.id}`, journeyState: "SERVICE_COMPLETED", reevaluation: null, duplicate: true });
  }
  if (wo.status !== "IN_PROGRESS" && wo.status !== "OPEN") return err(appError("WORK_ORDER_STATE", wo.status));

  const key = { vehicleId: wo.vehicleId, serviceCode: wo.booking.serviceCode };
  const pre = await precheckJourney(db, key, { type: "WORK_ORDER_COMPLETED", workOrderId: wo.id, serviceRecordId: "precheck" }, { actorId: cmd.actor.actorId, role: cmd.actor.role });
  if (!pre.ok) return pre;
  const lastVerified = await db.odometerReading.findFirst({ where: { vehicleId: wo.vehicleId, verification: "VERIFIED" }, orderBy: { valueKm: "desc" } });
  if (lastVerified && cmd.completionOdometerKm < lastVerified.valueKm) return err(appError("ODOMETER_ROLLBACK"));

  const closed = await workshop.completeWorkOrder({ workOrderRef: wo.externalRef ?? "", completionOdometerKm: cmd.completionOdometerKm });
  if (!closed.ok) return err(workshopErrorToApp(closed.error));

  const committed = await runInTransaction<{ serviceRecordId: string; journeyState: JourneyState }, AppError>(db, async (tx) => {
    await lockVehicle(tx, wo.vehicleId);
    const marked = await tx.workOrder.updateMany({
      where: { id: wo.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
      data: { status: "COMPLETED", completedAt: now, completedById: cmd.actor.actorId, completionOdometerKm: cmd.completionOdometerKm, invoiceRef: `SYNTHETIC-DEMO:invoice/${wo.externalRef}` },
    });
    if (marked.count !== 1) return err(appError("CONFLICT", "WORK_ORDER_ALREADY_CLOSED", { retryable: true }));
    const source = `SYNTHETIC-DEMO:mock-workshop/${wo.externalRef}`;
    const record = await tx.serviceRecord.create({
      data: {
        id: `svc-${wo.id}`,
        vehicleId: wo.vehicleId,
        serviceCode: wo.booking!.serviceCode,
        performedOn: new Date(`${toLocalDate(now)}T00:00:00.000Z`),
        odometerKm: cmd.completionOdometerKm,
        provenance: "WORKSHOP_VERIFIED",
        workshopId: wo.booking!.workshopId,
        workOrderId: wo.id,
        evidenceRef: `SYNTHETIC-DEMO:invoice/${wo.externalRef}`,
        recordedById: cmd.actor.actorId,
        dataOrigin: "SYNTHETIC",
        syntheticSourceRef: source,
        createdAt: now,
      },
    });
    await tx.odometerReading.create({
      data: {
        id: `odo-${wo.id}`,
        vehicleId: wo.vehicleId,
        valueKm: cmd.completionOdometerKm,
        observedAt: now,
        provenance: "WORKSHOP_VERIFIED",
        verification: "VERIFIED",
        recordedById: cmd.actor.actorId,
        traceId: cmd.traceId,
        dataOrigin: "SYNTHETIC",
        syntheticSourceRef: source,
        createdAt: now,
      },
    });
    const applied = await applyJourneyEventInTx(tx, {
      ...key,
      event: { type: "WORK_ORDER_COMPLETED", workOrderId: wo.id, serviceRecordId: record.id },
      actor: { actorId: cmd.actor.actorId, role: cmd.actor.role },
      traceId: cmd.traceId,
      idempotencyKey: `wo-completed:${wo.id}`,
    });
    if (!applied.ok) return err(journeyErrorToApp(applied.error));
    await audit(tx, { actor: cmd.actor, action: "WORK_ORDER_COMPLETED", entityType: "WorkOrder", entityId: wo.id, details: { serviceRecordId: record.id, completionOdometerKm: cmd.completionOdometerKm, source: closed.source }, traceId: cmd.traceId, at: now });
    return ok({ serviceRecordId: record.id, journeyState: applied.value.to });
  });
  if (!committed.ok) return committed;

  // Re-evaluación posterior al servicio: nuevo ciclo a partir del servicio verificado.
  let reevaluation: CompletedWorkOrder["reevaluation"] = null;
  let journeyState = committed.value.journeyState;
  const evaluated = await evaluateVehicle(deps, { actor: POST_SERVICE_EVALUATOR, vehicleId: wo.vehicleId, serviceCode: wo.booking.serviceCode, traceId: cmd.traceId });
  if (evaluated.ok) {
    reevaluation = { evaluationId: evaluated.value.evaluationId, status: evaluated.value.result.status };
    const applied = await applyJourneyEvent(db, {
      ...key,
      event: { type: "REEVALUATED", evaluationId: evaluated.value.evaluationId, status: evaluated.value.result.status },
      actor: { actorId: POST_SERVICE_EVALUATOR.actorId, role: POST_SERVICE_EVALUATOR.role },
      traceId: cmd.traceId,
      idempotencyKey: `reevaluated:${wo.id}`,
    });
    if (applied.ok) journeyState = applied.value.to;
  }

  const customerRef = await activeOwnerId(db, wo.vehicleId, now);
  if (customerRef) {
    await deps.crm.recordInteraction(
      { kind: "SERVICE_COMPLETED", customerRef, vehicleRef: wo.vehicleId, payload: { workOrderId: wo.id, serviceRecordId: committed.value.serviceRecordId } },
      `crm:service-completed:${wo.id}`,
    );
  }
  return ok({ workOrderId: wo.id, serviceRecordId: committed.value.serviceRecordId, odometerReadingId: `odo-${wo.id}`, journeyState, reevaluation, duplicate: false });
}
