import { planReminder, type ContactFrequencyPolicy } from "@/domain/contact/contact-policy";
import { INITIAL_STATE } from "@/domain/journey";
import type { DueStatus } from "@/domain/maintenance-engine";
import { isOwnershipActive } from "@/domain/policies/access-policy";
import type { OutboundChannel } from "@/domain/policies/consent-policy";
import { toLocalDate } from "@/domain/shared/local-date";
import { err, ok, type Result } from "@/domain/shared/result";
import type { NotificationPort, OutboundNotification } from "@/integrations/ports/notifications";
import { appError, type AppError } from "./errors";
import { findJourney } from "./journey/journey-store";
import type { Tx } from "./transaction";

export const REMINDER_TEMPLATE_ID = "maintenance-reminder-v1";

export type ReminderOutcome =
  | { outcome: "SKIPPED"; reason: "NOT_ACTIONABLE" | "JOURNEY_STATE" | "MIN_INTERVAL" | "NO_ACTIVE_OWNER" }
  | {
      outcome: "SIMULATED_SENT";
      outboundMessageId: string;
      channel: OutboundChannel;
      consentEventId: string;
      dedupKey: string;
      deduplicated: boolean;
      /** Solo en mensajes nuevos: entregar al puerto después del commit. */
      pendingNotification: OutboundNotification | null;
    }
  | {
      outcome: "SUPPRESSED";
      outboundMessageId: string;
      channel: OutboundChannel;
      suppressionReason: "CONSENT_REQUIRED" | "FREQUENCY_CAP";
      dedupKey: string;
      deduplicated: boolean;
    };

/**
 * Decide y registra el recordatorio de una evaluación dentro de la transacción del llamador (ADR-010, ADR-015).
 *
 * - Clave de deduplicación estable (ciclo + política + ventana + tipo), nunca `inputHash`: re-ejecutar el job
 *   devuelve el mensaje existente (`deduplicated: true`) y no vuelve a invocar el puerto.
 * - Sin consentimiento vigente: `SUPPRESSED` con motivo y sin `consentEventId`.
 * - No invoca el puerto: un efecto externo dentro de una transacción que puede reintentarse o revertirse
 *   se duplicaría o quedaría huérfano. Devuelve la notificación pendiente y `deliverReminder` la entrega
 *   tras el commit (outbox simplificado, ADR-015).
 */
export async function dispatchMaintenanceReminderInTx(
  tx: Tx,
  { evaluationId, now }: { evaluationId: string; now: Date },
): Promise<Result<ReminderOutcome, AppError>> {
  const evaluation = await tx.maintenanceEvaluation.findUnique({
    where: { id: evaluationId },
    select: {
      id: true,
      status: true,
      serviceCode: true,
      cycleKey: true,
      traceId: true,
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
                    select: { purpose: true, channel: true, isGranted: true, events: { select: { id: true, action: true, occurredAt: true } } },
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
  if (!evaluation.cycleKey) return ok({ outcome: "SKIPPED", reason: "NOT_ACTIONABLE" });

  const owner = evaluation.vehicle.ownerships.find((o) => isOwnershipActive(o, now))?.customer;
  if (!owner) return ok({ outcome: "SKIPPED", reason: "NO_ACTIVE_OWNER" });

  const policyRow = await tx.communicationPolicy.findFirst({ where: { isActive: true } });
  if (!policyRow) return err(appError("POLICY_MISSING"));
  const policy: ContactFrequencyPolicy = {
    policyVersion: policyRow.version,
    minDaysBetweenReminders: policyRow.minDaysBetweenReminders,
    maxRemindersPerCycle: policyRow.maxRemindersPerCycle,
  };

  const journey = await findJourney(tx, { vehicleId: evaluation.vehicle.id, serviceCode: evaluation.serviceCode });
  const sent = await tx.outboundMessage.findMany({
    where: { cycleKey: evaluation.cycleKey, status: "SIMULATED_SENT" },
    select: { createdAt: true },
  });

  const plan = planReminder({
    status: evaluation.status as DueStatus,
    journeyState: journey?.state ?? INITIAL_STATE,
    consents: owner.consents,
    sentInCycle: sent.map((m) => toLocalDate(m.createdAt)),
    today: toLocalDate(now),
    cycleKey: evaluation.cycleKey,
    policy,
  });
  if (plan.kind === "SKIP") return ok({ outcome: "SKIPPED", reason: plan.reason });

  const dedupKey = `${plan.dedupKey}:${plan.kind === "CONTACT" ? "SENT" : "SUPPRESSED"}`;
  const existing = await tx.outboundMessage.findUnique({ where: { dedupKey } });
  if (existing) {
    return ok(
      existing.status === "SIMULATED_SENT"
        ? { outcome: "SIMULATED_SENT", outboundMessageId: existing.id, channel: existing.channel as OutboundChannel, consentEventId: existing.consentEventId!, dedupKey, deduplicated: true, pendingNotification: null }
        : { outcome: "SUPPRESSED", outboundMessageId: existing.id, channel: existing.channel as OutboundChannel, suppressionReason: existing.suppressionReason as "CONSENT_REQUIRED" | "FREQUENCY_CAP", dedupKey, deduplicated: true },
    );
  }

  const synthetic = evaluation.vehicle.dataOrigin === "SYNTHETIC" || owner.dataOrigin === "SYNTHETIC";
  const base = {
    customerId: owner.id,
    vehicleId: evaluation.vehicle.id,
    channel: plan.channel,
    purpose: "MAINTENANCE_REMINDERS" as const,
    templateId: REMINDER_TEMPLATE_ID,
    traceId: evaluation.traceId ?? "no-trace",
    dataOrigin: synthetic ? ("SYNTHETIC" as const) : ("REAL" as const),
    syntheticSourceRef: synthetic ? `SYNTHETIC-DEMO:evaluation/${evaluationId}` : null,
    dedupKey,
    cycleKey: evaluation.cycleKey,
    evaluationId,
    // Reloj del dominio, no el de la base: la ventana y la separación mínima se calculan con la misma fecha.
    createdAt: now,
  };

  if (plan.kind === "SUPPRESS") {
    const message = await tx.outboundMessage.create({
      data: { ...base, status: "SUPPRESSED", suppressionReason: plan.reason, consentEventId: null },
      select: { id: true },
    });
    return ok({ outcome: "SUPPRESSED", outboundMessageId: message.id, channel: plan.channel, suppressionReason: plan.reason, dedupKey, deduplicated: false });
  }

  const message = await tx.outboundMessage.create({
    data: { ...base, status: "SIMULATED_SENT", consentEventId: plan.consentEventId },
    select: { id: true },
  });
  return ok({
    outcome: "SIMULATED_SENT",
    outboundMessageId: message.id,
    channel: plan.channel,
    consentEventId: plan.consentEventId,
    dedupKey,
    deduplicated: false,
    pendingNotification: { outboundMessageId: message.id, channel: plan.channel, templateId: REMINDER_TEMPLATE_ID, consentEventId: plan.consentEventId, dedupKey },
  });
}

/** Entrega posterior al commit. Solo mensajes nuevos con evidencia de consentimiento llegan al puerto (MOCK). */
export async function deliverReminder(notifications: NotificationPort, outcome: ReminderOutcome): Promise<void> {
  if (outcome.outcome === "SIMULATED_SENT" && outcome.pendingNotification) {
    await notifications.send(outcome.pendingNotification);
  }
}
