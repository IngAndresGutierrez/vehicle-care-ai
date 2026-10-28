/**
 * Consentimiento por finalidad y canal (Ley 1581 de 2012, ARCHITECTURE.md §8, ADR-010).
 * Puro y con denegación por defecto: sin evidencia vigente de GRANTED no hay contacto saliente.
 */

export type ConsentPurpose = "SERVICE_OPERATIONAL" | "MAINTENANCE_REMINDERS" | "MARKETING" | "AI_ASSISTANT_PROCESSING";
export type Channel = "PORTAL" | "EMAIL" | "SMS" | "WHATSAPP" | "PHONE";
export type OutboundChannel = Exclude<Channel, "PORTAL">;

export interface ConsentFacts {
  purpose: ConsentPurpose;
  channel: Channel;
  /** Proyección del último evento; debe coincidir con la evidencia. */
  isGranted: boolean;
  events: ReadonlyArray<{ id: string; action: "GRANTED" | "REVOKED"; occurredAt: Date }>;
}

export type ConsentDenyDetail = "NO_CONSENT_RECORD" | "NO_EVIDENCE" | "REVOKED" | "PROJECTION_MISMATCH" | "NOT_OUTBOUND_CHANNEL";

export type ConsentDecision =
  | { allowed: true; consentEventId: string }
  | { allowed: false; reason: "CONSENT_REQUIRED"; detail: ConsentDenyDetail };

const deny = (detail: ConsentDenyDetail): ConsentDecision => ({ allowed: false, reason: "CONSENT_REQUIRED", detail });

export function decideOutboundContact(
  consents: readonly ConsentFacts[],
  purpose: ConsentPurpose,
  channel: Channel,
): ConsentDecision {
  // El portal no es un canal saliente: la consulta voluntaria no requiere opt-in de mensajería (EX-04).
  if (channel === "PORTAL") return deny("NOT_OUTBOUND_CHANNEL");

  const consent = consents.find((c) => c.purpose === purpose && c.channel === channel);
  if (!consent) return deny("NO_CONSENT_RECORD");

  const latest = [...consent.events].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
  ).at(-1);
  if (!latest) return deny("NO_EVIDENCE");
  if (latest.action === "REVOKED") return deny("REVOKED");
  // La proyección contradice la evidencia: fallar cerrado.
  if (!consent.isGranted) return deny("PROJECTION_MISMATCH");

  return { allowed: true, consentEventId: latest.id };
}

/** Orden de preferencia de canales para recordatorios de mantenimiento (ADR-014). */
export const REMINDER_CHANNEL_PRIORITY: readonly OutboundChannel[] = ["WHATSAPP", "EMAIL", "SMS"];

export type ReminderChannelDecision =
  | { allowed: true; channel: OutboundChannel; consentEventId: string }
  | { allowed: false; channel: OutboundChannel; reason: "CONSENT_REQUIRED"; detail: ConsentDenyDetail };

/**
 * Primer canal autorizado para `MAINTENANCE_REMINDERS`. Si ninguno lo está, devuelve el canal preferido
 * con el motivo de denegación, para registrar la supresión.
 */
export function chooseReminderChannel(
  consents: readonly ConsentFacts[],
  priority: readonly OutboundChannel[] = REMINDER_CHANNEL_PRIORITY,
): ReminderChannelDecision {
  let firstDenial: { channel: OutboundChannel; detail: ConsentDenyDetail } | null = null;
  for (const channel of priority) {
    const decision = decideOutboundContact(consents, "MAINTENANCE_REMINDERS", channel);
    if (decision.allowed) return { allowed: true, channel, consentEventId: decision.consentEventId };
    firstDenial ??= { channel, detail: decision.detail };
  }
  if (!firstDenial) throw new Error("chooseReminderChannel: la lista de canales está vacía");
  return { allowed: false, channel: firstDenial.channel, reason: "CONSENT_REQUIRED", detail: firstDenial.detail };
}

/**
 * Consentimiento para tratar los mensajes del propietario con el asistente de IA (D-12, ADR-018).
 * Se otorga en el portal; sin evidencia GRANTED vigente el asistente no procesa la conversación.
 */
export function decideProcessingConsent(
  consents: readonly ConsentFacts[],
  purpose: ConsentPurpose = "AI_ASSISTANT_PROCESSING",
): ConsentDecision {
  const consent = consents.find((c) => c.purpose === purpose && c.channel === "PORTAL");
  if (!consent) return deny("NO_CONSENT_RECORD");
  const latest = [...consent.events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id)).at(-1);
  if (!latest) return deny("NO_EVIDENCE");
  if (latest.action === "REVOKED") return deny("REVOKED");
  if (!consent.isGranted) return deny("PROJECTION_MISMATCH");
  return { allowed: true, consentEventId: latest.id };
}
