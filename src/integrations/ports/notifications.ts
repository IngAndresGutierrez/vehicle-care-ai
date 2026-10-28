import type { OutboundChannel } from "@/domain/policies/consent-policy";

/** Puerto de mensajería saliente (ARCHITECTURE.md §7.1). En el MVP solo existe el adaptador mock. */
export interface OutboundNotification {
  outboundMessageId: string;
  channel: OutboundChannel;
  templateId: string;
  /** Evidencia del consentimiento usado: sin ella no se invoca el puerto. */
  consentEventId: string;
  dedupKey: string;
}

export interface NotificationReceipt {
  accepted: boolean;
  /** true: nada salió del sistema. */
  simulated: boolean;
}

export interface NotificationPort {
  send(notification: OutboundNotification): Promise<NotificationReceipt>;
}
