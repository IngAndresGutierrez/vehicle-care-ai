import { evaluate, type EvaluationResult } from "@/domain/maintenance-engine";
import type { ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { AppError } from "./errors";
import { buildEvaluationContext } from "./evaluation-context-builder";
import { authorizeVehicleAccess } from "./vehicle-access";

export interface EvaluateVehicleDeps {
  db: Db;
  clock: Clock;
}

export interface EvaluateVehicleCommand {
  actor: ActorContext;
  vehicleId: string;
  serviceCode: string;
  traceId: string;
}

export interface EvaluateVehicleOutput {
  evaluationId: string;
  result: EvaluationResult;
}

/**
 * Autoriza, ensambla el contexto desde PostgreSQL, ejecuta el motor puro y persiste el resultado
 * como `MaintenanceEvaluation` inmutable (con inputHash, versión del motor, traza, fuente y origen sintético).
 */
export async function evaluateVehicle(
  { db, clock }: EvaluateVehicleDeps,
  cmd: EvaluateVehicleCommand,
): Promise<Result<EvaluateVehicleOutput, AppError>> {
  const now = clock.now();

  const access = await authorizeVehicleAccess(db, cmd.actor, cmd.vehicleId, "EVALUATE_VEHICLE", now);
  if (!access.ok) return access;

  const context = await buildEvaluationContext(db, cmd.vehicleId, cmd.serviceCode, now);
  if (!context.ok) return err(context.error);

  const result = evaluate(context.value.input, context.value.policies, now);

  const row = await db.maintenanceEvaluation.create({
    data: {
      vehicleId: result.vehicleId,
      serviceCode: result.serviceCode,
      status: result.status,
      technicalStatus: result.technical.status,
      communicationStatus: result.communication?.status ?? null,
      reasons: result.reasons,
      dueByKm: result.technical.dueBy?.km ?? null,
      dueByDate: result.technical.dueBy?.date ? fromIsoLocalDate(result.technical.dueBy.date) : null,
      reachedBy: result.technical.reachedBy,
      triggeredBy: result.communication?.triggeredBy ?? null,
      remainingKm: result.technical.remaining?.km ?? null,
      remainingDays: result.technical.remaining?.days ?? null,
      requiresOdometerConfirmation: result.requiresOdometerConfirmation,
      suggestedAction: result.suggestedAction,
      planVersionId: result.plan?.planVersionId ?? null,
      planVersionLabel: result.plan?.version ?? null,
      planSourceRef: result.plan?.sourceRef ?? null,
      ruleId: result.ruleId,
      asOfLocalDate: fromIsoLocalDate(result.asOf.localDate),
      commPolicyVersion: context.value.policies.communication.policyVersion,
      dataQualityPolicyVersion: result.dataQualityPolicyVersion,
      containsSyntheticData: result.dataOrigin.containsSyntheticData,
      syntheticSources: result.dataOrigin.syntheticSources,
      engineVersion: result.engineVersion,
      inputHash: result.inputHash,
      inputSnapshot: context.value.input as unknown as Prisma.InputJsonValue,
      decisionTrace: result.decisionTrace as unknown as Prisma.InputJsonValue,
      evaluatedAt: now,
      traceId: cmd.traceId,
    },
    select: { id: true },
  });

  return ok({ evaluationId: row.id, result });
}

function fromIsoLocalDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
