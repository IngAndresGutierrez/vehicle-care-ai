import type { Db } from "@/infra/prisma";
import type { CrmConsent, CrmCustomer, CrmDelivery, CrmInteraction, CrmPort, CrmResult } from "../ports/crm";
import { consumeScenario } from "./mock-scenarios";

/**
 * ⚠️ CRM SIMULADO (MOCK). Lee los registros sintéticos de la base (como si fueran el CRM de la agencia) y
 * guarda las interacciones en `MockCrmInteraction`. Todo resultado se marca `source: "MOCK"`.
 */
export class MockCrmAdapter implements CrmPort {
  constructor(private readonly db: Db) {}

  private unavailable<T>(): CrmResult<T> {
    return { ok: false, error: { code: "CRM_UNAVAILABLE", retryable: true }, source: "MOCK" };
  }

  async getCustomer(customerRef: string): Promise<CrmResult<CrmCustomer>> {
    if (await consumeScenario(this.db, "CRM_DOWN")) return this.unavailable();
    const c = await this.db.customer.findUnique({ where: { id: customerRef } });
    if (!c) return { ok: false, error: { code: "NOT_FOUND", retryable: false }, source: "MOCK" };
    return { ok: true, data: { customerRef: c.id, displayName: c.displayName, city: c.city, dataOrigin: c.dataOrigin }, source: "MOCK" };
  }

  async getDeliveryRecord(vehicleRef: string): Promise<CrmResult<CrmDelivery>> {
    if (await consumeScenario(this.db, "CRM_DOWN")) return this.unavailable();
    const v = await this.db.vehicle.findUnique({ where: { id: vehicleRef } });
    if (!v) return { ok: false, error: { code: "NOT_FOUND", retryable: false }, source: "MOCK" };
    return { ok: true, data: { vehicleRef: v.id, deliveredAt: v.deliveredAt, deliveryOdometerKm: v.deliveryOdometerKm }, source: "MOCK" };
  }

  async getConsents(customerRef: string): Promise<CrmResult<CrmConsent[]>> {
    if (await consumeScenario(this.db, "CRM_DOWN")) return this.unavailable();
    const consents = await this.db.consent.findMany({ where: { customerId: customerRef } });
    return { ok: true, data: consents.map((c) => ({ purpose: c.purpose, channel: c.channel, isGranted: c.isGranted })), source: "MOCK" };
  }

  async recordInteraction(interaction: CrmInteraction, idempotencyKey: string): Promise<CrmResult<{ interactionId: string }>> {
    if (await consumeScenario(this.db, "CRM_DOWN")) return this.unavailable();
    const row = await this.db.mockCrmInteraction.upsert({
      where: { idempotencyKey },
      create: { idempotencyKey, kind: interaction.kind, customerRef: interaction.customerRef, vehicleRef: interaction.vehicleRef, payload: interaction.payload },
      update: {},
    });
    if (row.kind !== interaction.kind || row.vehicleRef !== interaction.vehicleRef) {
      return { ok: false, error: { code: "IDEMPOTENCY_MISMATCH", retryable: false }, source: "MOCK" };
    }
    return { ok: true, data: { interactionId: row.id }, source: "MOCK" };
  }
}
