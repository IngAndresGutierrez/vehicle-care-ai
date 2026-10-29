import { isRedundantEvaluation, JOB_MANAGED_STATES, type JourneyActor, type JourneyState } from "@/domain/journey";
import type { DueStatus } from "@/domain/maintenance-engine";
import type { ActorContext } from "@/domain/policies/access-policy";
import { ok } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import type { NotificationPort } from "@/integrations/ports/notifications";
import { deliverReminder, dispatchMaintenanceReminderInTx, type ReminderOutcome } from "./dispatch-maintenance-reminder";
import type { AppError } from "./errors";
import { evaluateVehicle } from "./evaluate-vehicle";
import { applyJourneyEventInTx, ensureJourney, type JourneyStoreError } from "./journey/journey-store";
import { runInTransaction } from "./transaction";

/** Servicio P0 del MVP: se evalúa aunque el vehículo no tenga plan (resultado PLAN_MISSING trazable). */
export const P0_SERVICE_CODES = ["ENGINE_OIL_FILTER"] as const;

/** Qué pasó con el evento EVALUATED: aplicado, ya existía, no aportaba información o el job no gestiona ese estado. */
export type EvaluatedEventOutcome = "APPLIED" | "DUPLICATE" | "REDUNDANT" | "NOT_JOB_MANAGED";

interface JobStep {
  state: JourneyState;
  evaluatedEvent: EvaluatedEventOutcome;
  reminder: ReminderOutcome;
}

export interface JobItem {
  vehicleId: string;
  serviceCode: string;
  evaluation: { evaluationId: string; status: DueStatus } | { error: AppError };
  journey?: { state: JourneyState; evaluatedEvent: EvaluatedEventOutcome } | { error: JourneyStoreError | AppError };
  reminder?: ReminderOutcome;
}

export interface JobDeps {
  db: Db;
  clock: Clock;
  notifications: NotificationPort;
}

/**
 * Job de evaluación (ARCHITECTURE.md §4.1). Por vehículo con titular vigente y servicio de su plan:
 * 1. evalúa y persiste (auditoría: una fila por ejecución);
 * 2. en una transacción: aplica EVALUATED al journey (si el estado lo gestiona el job y aporta información)
 *    y, si el journey es contactable, registra el recordatorio deduplicado y su evento CONTACT_*;
 * 3. tras el commit entrega la notificación nueva al puerto (MOCK).
 * Re-ejecutarlo no duplica eventos, mensajes ni notificaciones (ADR-015).
 */
export async function runEvaluationJob(
  deps: JobDeps,
  { actor, traceId, vehicleIds }: { actor: ActorContext; traceId: string; /** Opcional: limita el job a estos vehículos. */ vehicleIds?: string[] },
): Promise<JobItem[]> {
  const now = deps.clock.now();
  const journeyActor: JourneyActor = { actorId: actor.actorId, role: actor.role };
  const vehicles = await deps.db.vehicle.findMany({
    where: {
      ownerships: { some: { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] } },
      ...(vehicleIds ? { id: { in: vehicleIds } } : {}),
    },
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
      const { evaluationId, result, cycleKey } = evaluated.value;
      const item: JobItem = { vehicleId: vehicle.id, serviceCode, evaluation: { evaluationId, status: result.status } };

      const step = await runInTransaction<JobStep, JourneyStoreError | AppError>(
        deps.db,
        async (tx) => {
          const journey = await ensureJourney(tx, { vehicleId: vehicle.id, serviceCode });
          let state = journey.state;
          let evaluatedEvent: EvaluatedEventOutcome = "NOT_JOB_MANAGED";

          if (JOB_MANAGED_STATES.has(journey.state)) {
            const event = {
              type: "EVALUATED" as const,
              evaluationId,
              status: result.status,
              reasons: result.reasons,
              requiresOdometerConfirmation: result.requiresOdometerConfirmation,
              cycleKey,
            };
            if (isRedundantEvaluation({ state: journey.state, context: journey.context }, event, journeyActor)) {
              evaluatedEvent = "REDUNDANT";
            } else {
              const applied = await applyJourneyEventInTx(tx, {
                vehicleId: vehicle.id,
                serviceCode,
                event,
                actor: journeyActor,
                traceId,
                idempotencyKey: `evaluated:${evaluationId}`,
              });
              if (!applied.ok) return applied;
              state = applied.value.to;
              evaluatedEvent = applied.value.status;
            }
          }

          const reminder = await dispatchMaintenanceReminderInTx(tx, { evaluationId, now });
          if (!reminder.ok) return reminder;
          if (reminder.value.outcome === "SIMULATED_SENT" || reminder.value.outcome === "SUPPRESSED") {
            const contact = reminder.value;
            const applied = await applyJourneyEventInTx(tx, {
              vehicleId: vehicle.id,
              serviceCode,
              event:
                contact.outcome === "SIMULATED_SENT"
                  ? { type: "CONTACT_SENT", outboundMessageId: contact.outboundMessageId, dedupKey: contact.dedupKey }
                  : { type: "CONTACT_SUPPRESSED", outboundMessageId: contact.outboundMessageId, dedupKey: contact.dedupKey, reason: contact.suppressionReason },
              actor: journeyActor,
              traceId,
              idempotencyKey: `contact:${contact.dedupKey}`,
            });
            if (!applied.ok) return applied;
            state = applied.value.to;
          }
          return ok({ state, evaluatedEvent, reminder: reminder.value });
        },
      );

      if (step.ok) {
        item.journey = { state: step.value.state, evaluatedEvent: step.value.evaluatedEvent };
        item.reminder = step.value.reminder;
        await deliverReminder(deps.notifications, step.value.reminder);
      } else {
        item.journey = { error: step.error };
      }
      items.push(item);
    }
  }
  return items;
}
