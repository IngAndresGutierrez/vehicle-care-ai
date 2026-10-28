/**
 * Puerto del sistema de taller (ARCHITECTURE.md §7.1). Los adaptadores traducen los códigos y formatos del
 * proveedor a estos tipos (capa anticorrupción) y **nunca lanzan** por errores de negocio.
 * Todo resultado declara su origen: en el MVP siempre `MOCK`.
 */

export type IntegrationSource = "MOCK" | "REAL";

/** Errores del taller ya traducidos al dominio. */
export type WorkshopErrorCode =
  | "SLOT_CONFLICT" // el cupo se agotó o dejó de existir
  | "NO_SLOTS" // no hay cupos en el rango pedido
  | "QUOTE_EXPIRED" // el taller ya no honra la cotización
  | "QUOTE_UNAVAILABLE" // el catálogo no tiene precio para el servicio/vehículo
  | "WORKSHOP_UNAVAILABLE" // el taller rechazó o no recibió la solicitud: no se procesó
  | "OUTCOME_UNCERTAIN" // la solicitud pudo procesarse pero no hubo respuesta: reconciliar, no reintentar a ciegas
  | "IDEMPOTENCY_MISMATCH" // misma clave con distinto contenido
  | "NOT_FOUND"
  | "INVALID_STATE";

export interface WorkshopError {
  code: WorkshopErrorCode;
  retryable: boolean;
  /** Código original del proveedor, solo para diagnóstico. */
  raw?: string;
}

export type WsResult<T> =
  | { ok: true; data: T; source: IntegrationSource }
  | { ok: false; error: WorkshopError; source: IntegrationSource };

export interface WsQuote {
  externalQuoteRef: string;
  isEstimate: boolean;
  subtotalCop: number;
  taxCop: number;
  totalCop: number;
  taxLabel: string;
  includedItems: Array<{ description: string; qty: number }>;
  restrictions: string[];
  catalogVersion: string;
  validUntil: Date;
}

export interface WsSlot {
  slotRef: string;
  startsAt: Date;
  endsAt: Date;
  remaining: number;
}

export interface WsBooking {
  folio: string;
  slotRef: string;
  startsAt: Date;
  status: "CONFIRMED" | "CANCELLED";
}

export interface WsWorkOrder {
  workOrderRef: string;
  folio: string;
  status: "OPEN" | "COMPLETED";
  completionOdometerKm: number | null;
}

export interface WorkshopPort {
  getQuote(req: { workshopRef: string; externalServiceCode: string; specKey: string }): Promise<WsResult<WsQuote>>;
  listSlots(req: { workshopRef: string; externalServiceCode: string; from: Date; to: Date }): Promise<WsResult<WsSlot[]>>;
  getSlot(req: { workshopRef: string; slotRef: string }): Promise<WsResult<WsSlot>>;
  /** Revalida cotización y cupo del lado del taller. Idempotente por `idempotencyKey`. */
  createBooking(
    req: { workshopRef: string; slotRef: string; externalQuoteRef: string; customerRef: string; vehicleRef: string },
    idempotencyKey: string,
  ): Promise<WsResult<WsBooking>>;
  /** Consulta por clave de idempotencia: base de la reconciliación de resultados inciertos. */
  findBooking(idempotencyKey: string): Promise<WsResult<WsBooking | null>>;
  cancelBooking(folio: string): Promise<WsResult<WsBooking>>;
  openWorkOrder(folio: string): Promise<WsResult<WsWorkOrder>>;
  completeWorkOrder(req: { workOrderRef: string; completionOdometerKm: number }): Promise<WsResult<WsWorkOrder>>;
}
