import type { IntegrationSource } from "./workshop";

/** Puerto del CRM/DMS de la agencia (ARCHITECTURE.md §7.1). Nunca lanza por errores de negocio. */

export type CrmErrorCode = "CRM_UNAVAILABLE" | "NOT_FOUND" | "IDEMPOTENCY_MISMATCH";

export type CrmResult<T> =
  | { ok: true; data: T; source: IntegrationSource }
  | { ok: false; error: { code: CrmErrorCode; retryable: boolean }; source: IntegrationSource };

export interface CrmCustomer {
  customerRef: string;
  displayName: string;
  city: string | null;
  dataOrigin: "REAL" | "SYNTHETIC";
}

export interface CrmDelivery {
  vehicleRef: string;
  deliveredAt: Date | null;
  deliveryOdometerKm: number | null;
}

export interface CrmConsent {
  purpose: string;
  channel: string;
  isGranted: boolean;
}

export type CrmInteractionKind = "BOOKING_CONFIRMED" | "BOOKING_FAILED" | "HUMAN_CASE_OPENED" | "SERVICE_COMPLETED";

export interface CrmInteraction {
  kind: CrmInteractionKind;
  customerRef: string;
  vehicleRef: string;
  /** Solo identificadores y estados; nunca tokens ni texto libre del cliente. */
  payload: Record<string, string | number | boolean | null>;
}

export interface CrmPort {
  getCustomer(customerRef: string): Promise<CrmResult<CrmCustomer>>;
  getDeliveryRecord(vehicleRef: string): Promise<CrmResult<CrmDelivery>>;
  getConsents(customerRef: string): Promise<CrmResult<CrmConsent[]>>;
  recordInteraction(interaction: CrmInteraction, idempotencyKey: string): Promise<CrmResult<{ interactionId: string }>>;
}
