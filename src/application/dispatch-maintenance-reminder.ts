import { isOwnershipActive } from "@/domain/policies/access-policy";
import { chooseReminderChannel, type OutboundChannel } from "@/domain/policies/consent-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { appError, type AppError } from "./errors";

export const REMINDER_TEMPLATE_ID = "maintenance-reminder-v1";
const ACTIONABLE = new Set(["UPCOMING", "DUE", "OVERDUE"]);

export type ReminderOutcome =
  | { outcome: "NO_CONTACT_NEEDED"; status: string }
  | { outcome: "NO_ACTIVE_OWNER" }
  | { outcome: "SIMULATED_SENT"; outboundMessageId: string; channel: OutboundChannel; consentEventId: string }
  | { outcome: "SUPPRESSED"; outboundMessageId: string; channel: OutboundChannel; suppressionReason: "CONSENT_REQUIRED" };

/**
 * Decide si una evaluación genera un recordatorio y lo registra como `OutboundMessage` (ADR-010).
 *
 * Nada sale del sistema en el MVP: `SIMULATED_SENT` solo deja constancia (no hay proveedor de mensajería).
 * Sin consentimiento `MAINTENANCE_REMINDERS` vigente el mensaje queda `SUPPRESSED`, con `suppressionReason`
 * y sin `consentEventId`.
 */
export async function dispatchMaintenanceReminder(
  { db, clock }: { db: Db; clock: Clock },
  { evaluationId, traceId }: { evaluationId: string; traceId: string },
): Promise<Result<ReminderOutcome, AppError>> {
  const now = clock.now();
  const evaluation = await db.maintenanceEvaluation.findUnique({
    where: { id: evaluationId },
    select: {
      status: true,
      vehicle: {
        select: {
          id: true,
          dataOrigin: true,
          ownerships: {
            select: {
              validFrom: true,
              validTo: true,
              customer: {
                select: {
                  id: true,
                  dataOrigin: true,
                  consents: {
                    select: {
                      purpose: true,
                      channel: true,
                      isGranted: true,
                      events: { select: { id: true, action: true, occurredAt: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!evaluation) return err(appError("EVALUATION_NOT_FOUND"));
  if (!ACTIONABLE.has(evaluation.status)) return ok({ outcome: "NO_CONTACT_NEEDED", status: evaluation.status });

  const owner = evaluation.vehicle.ownerships.find((o) => isOwnershipActive(o, now))?.customer;
  if (!owner) return ok({ outcome: "NO_ACTIVE_OWNER" });

  const decision = chooseReminderChannel(owner.consents);
  const synthetic = evaluation.vehicle.dataOrigin === "SYNTHETIC" || owner.dataOrigin === "SYNTHETIC";
  const base = {
    customerId: owner.id,
    vehicleId: evaluation.vehicle.id,
    channel: decision.channel,
    purpose: "MAINTENANCE_REMINDERS" as const,
    templateId: REMINDER_TEMPLATE_ID,
    traceId,
    dataOrigin: synthetic ? ("SYNTHETIC" as const) : ("REAL" as const),
    syntheticSourceRef: synthetic ? `SYNTHETIC-DEMO:evaluation/${evaluationId}` : null,
  };

  if (decision.allowed) {
    const message = await db.outboundMessage.create({
      data: { ...base, status: "SIMULATED_SENT", consentEventId: decision.consentEventId },
      select: { id: true },
    });
    return ok({
      outcome: "SIMULATED_SENT",
      outboundMessageId: message.id,
      channel: decision.channel,
      consentEventId: decision.consentEventId,
    });
  }

  const message = await db.outboundMessage.create({
    data: { ...base, status: "SUPPRESSED", suppressionReason: decision.reason, consentEventId: null },
    select: { id: true },
  });
  return ok({
    outcome: "SUPPRESSED",
    outboundMessageId: message.id,
    channel: decision.channel,
    suppressionReason: decision.reason,
  });
}
