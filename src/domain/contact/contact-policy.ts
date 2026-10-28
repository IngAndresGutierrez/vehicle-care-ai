import { CONTACTABLE_STATES, type JourneyState } from "../journey/states";
import type { DueStatus } from "../maintenance-engine/types";
import { chooseReminderChannel, type ConsentFacts, type OutboundChannel } from "../policies/consent-policy";
import { addDaysToLocalDate, daysBetween, type IsoLocalDate } from "../shared/local-date";

/**
 * Política de contacto para recordatorios de mantenimiento (ADR-015). Pura y determinista.
 *
 * La deduplicación NO usa `inputHash` (incluye `now`): se basa en el ciclo de mantenimiento (regla +
 * servicio de referencia), la versión de política y una ventana de contacto de calendario.
 */

export interface ContactFrequencyPolicy {
  policyVersion: string;
  /** Separación mínima entre recordatorios enviados del mismo ciclo; también es el ancho de la ventana. */
  minDaysBetweenReminders: number;
  /** Máximo de recordatorios enviados por ciclo de mantenimiento. */
  maxRemindersPerCycle: number;
}

/** Identifica la ocurrencia de mantenimiento: cambia solo cuando se registra un nuevo servicio de referencia o cambia la regla. */
export function maintenanceCycleKey(p: {
  vehicleId: string;
  serviceCode: string;
  ruleId: string | null;
  baselineServiceRecordId: string | null;
}): string {
  return [p.vehicleId, p.serviceCode, p.ruleId ?? "NO_RULE", p.baselineServiceRecordId ?? "NO_BASELINE"].join(":");
}

/** Inicio de la ventana de contacto: bloques fijos de `windowDays` días desde 1970-01-01 (estable entre ejecuciones). */
export function contactWindowStart(today: IsoLocalDate, windowDays: number): IsoLocalDate {
  const width = Math.max(1, Math.trunc(windowDays));
  const epochDay = daysBetween("1970-01-01", today);
  return addDaysToLocalDate("1970-01-01", epochDay - (((epochDay % width) + width) % width));
}

export function reminderDedupKey(p: { cycleKey: string; policyVersion: string; windowStart: IsoLocalDate }): string {
  return `reminder:v1:${p.cycleKey}:${p.policyVersion}:${p.windowStart}`;
}

export type ReminderPlan =
  | { kind: "CONTACT"; channel: OutboundChannel; consentEventId: string; dedupKey: string }
  | { kind: "SUPPRESS"; channel: OutboundChannel; reason: "CONSENT_REQUIRED" | "FREQUENCY_CAP"; dedupKey: string }
  | { kind: "SKIP"; reason: "NOT_ACTIONABLE" | "JOURNEY_STATE" | "MIN_INTERVAL" };

export interface ReminderInput {
  status: DueStatus;
  journeyState: JourneyState;
  consents: readonly ConsentFacts[];
  /** Fechas (America/Bogota) de los recordatorios ya enviados en este ciclo. */
  sentInCycle: readonly IsoLocalDate[];
  today: IsoLocalDate;
  cycleKey: string;
  policy: ContactFrequencyPolicy;
}

const ACTIONABLE = new Set<DueStatus>(["UPCOMING", "DUE", "OVERDUE"]);

/**
 * Orden: necesidad → estado del journey → consentimiento (sin él, SUPPRESS y nunca envío) → tope por ciclo
 * → separación mínima. SUPPRESS deja constancia una vez por ventana; SKIP no registra nada.
 */
export function planReminder(input: ReminderInput): ReminderPlan {
  if (!ACTIONABLE.has(input.status)) return { kind: "SKIP", reason: "NOT_ACTIONABLE" };
  if (!CONTACTABLE_STATES.has(input.journeyState)) return { kind: "SKIP", reason: "JOURNEY_STATE" };

  const dedupKey = reminderDedupKey({
    cycleKey: input.cycleKey,
    policyVersion: input.policy.policyVersion,
    windowStart: contactWindowStart(input.today, input.policy.minDaysBetweenReminders),
  });

  const channel = chooseReminderChannel(input.consents);
  if (!channel.allowed) return { kind: "SUPPRESS", channel: channel.channel, reason: "CONSENT_REQUIRED", dedupKey };

  if (input.sentInCycle.length >= input.policy.maxRemindersPerCycle) {
    return { kind: "SUPPRESS", channel: channel.channel, reason: "FREQUENCY_CAP", dedupKey };
  }
  const lastSent = [...input.sentInCycle].sort().at(-1);
  if (lastSent && daysBetween(lastSent, input.today) < input.policy.minDaysBetweenReminders) {
    return { kind: "SKIP", reason: "MIN_INTERVAL" };
  }
  return { kind: "CONTACT", channel: channel.channel, consentEventId: channel.consentEventId, dedupKey };
}
