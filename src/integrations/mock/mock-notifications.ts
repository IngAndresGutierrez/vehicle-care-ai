import type { NotificationPort, NotificationReceipt, OutboundNotification } from "../ports/notifications";

/**
 * Adaptador MOCK: nunca envía mensajes reales (sin red, sin proveedor). Conserva las llamadas en memoria
 * para que los tests comprueben cuántas «salidas» se habrían producido.
 */
export class MockNotificationPort implements NotificationPort {
  readonly sent: OutboundNotification[] = [];

  async send(notification: OutboundNotification): Promise<NotificationReceipt> {
    this.sent.push(notification);
    return { accepted: true, simulated: true };
  }
}
