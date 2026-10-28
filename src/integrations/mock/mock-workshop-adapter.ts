import type { WorkshopError, WorkshopErrorCode, WorkshopPort, WsBooking, WsQuote, WsResult, WsSlot, WsWorkOrder } from "../ports/workshop";
import type { MockWorkshopSystem, RawBooking, RawErrorCode, RawResponse, RawSlot, RawWorkOrder } from "./mock-workshop-system";

/**
 * Capa anticorrupción (ARCHITECTURE.md §7.2): traduce la API del taller simulado a los tipos del puerto.
 * Todo resultado se marca `source: "MOCK"`.
 */
export const RAW_ERROR_MAP: Readonly<Record<RawErrorCode, { code: WorkshopErrorCode; retryable: boolean }>> = {
  SERVICIO_NO_DISPONIBLE: { code: "WORKSHOP_UNAVAILABLE", retryable: true },
  TIEMPO_AGOTADO: { code: "OUTCOME_UNCERTAIN", retryable: false },
  SIN_TARIFA: { code: "QUOTE_UNAVAILABLE", retryable: false },
  SIN_CUPOS: { code: "NO_SLOTS", retryable: false },
  CUPO_NO_DISPONIBLE: { code: "SLOT_CONFLICT", retryable: false },
  CUPO_INEXISTENTE: { code: "SLOT_CONFLICT", retryable: false },
  COTIZACION_VENCIDA: { code: "QUOTE_EXPIRED", retryable: false },
  COTIZACION_INEXISTENTE: { code: "QUOTE_EXPIRED", retryable: false },
  CLAVE_REUTILIZADA: { code: "IDEMPOTENCY_MISMATCH", retryable: false },
  RESERVA_INEXISTENTE: { code: "NOT_FOUND", retryable: false },
  ORDEN_INEXISTENTE: { code: "NOT_FOUND", retryable: false },
  ESTADO_INVALIDO: { code: "INVALID_STATE", retryable: false },
};

export function mapRawError(codigo: string): WorkshopError {
  const mapped = RAW_ERROR_MAP[codigo as RawErrorCode];
  // Un código desconocido se trata como indisponibilidad, nunca como éxito.
  return mapped ? { ...mapped, raw: codigo } : { code: "WORKSHOP_UNAVAILABLE", retryable: true, raw: codigo };
}

function translate<R, T>(response: RawResponse<R>, map: (body: R) => T): WsResult<T> {
  return response.status === 200
    ? { ok: true, data: map(response.body), source: "MOCK" }
    : { ok: false, error: mapRawError(response.codigo), source: "MOCK" };
}

const slot = (s: RawSlot): WsSlot => ({ slotRef: s.cupo, startsAt: new Date(s.inicio), endsAt: new Date(s.fin), remaining: s.disponibles });
const booking = (b: RawBooking): WsBooking => ({ folio: b.folio, slotRef: b.cupo, startsAt: new Date(b.inicio), status: b.estado });
const workOrder = (w: RawWorkOrder): WsWorkOrder => ({
  workOrderRef: w.referencia,
  folio: w.folioReserva,
  status: w.estado,
  completionOdometerKm: w.kilometrajeCierre,
});

export class MockWorkshopAdapter implements WorkshopPort {
  constructor(private readonly system: MockWorkshopSystem) {}

  async getQuote(req: { workshopRef: string; externalServiceCode: string; specKey: string }): Promise<WsResult<WsQuote>> {
    const r = await this.system.cotizar({ taller: req.workshopRef, servicio: req.externalServiceCode, specKey: req.specKey });
    return translate(r, (q) => ({
      externalQuoteRef: q.referencia,
      isEstimate: q.esEstimado,
      subtotalCop: q.subtotal,
      taxCop: q.iva,
      totalCop: q.total,
      taxLabel: q.etiquetaImpuesto,
      includedItems: q.items.map((i) => ({ description: i.descripcion, qty: i.cantidad })),
      restrictions: q.restricciones,
      catalogVersion: q.versionCatalogo,
      validUntil: new Date(q.validoHasta),
    }));
  }

  async listSlots(req: { workshopRef: string; externalServiceCode: string; from: Date; to: Date }): Promise<WsResult<WsSlot[]>> {
    const r = await this.system.cupos({ taller: req.workshopRef, servicio: req.externalServiceCode, desde: req.from, hasta: req.to });
    return translate(r, (list) => list.map(slot));
  }

  async getSlot(req: { workshopRef: string; slotRef: string }): Promise<WsResult<WsSlot>> {
    return translate(await this.system.cupo({ taller: req.workshopRef, cupo: req.slotRef }), slot);
  }

  async createBooking(
    req: { workshopRef: string; slotRef: string; externalQuoteRef: string; customerRef: string; vehicleRef: string },
    idempotencyKey: string,
  ): Promise<WsResult<WsBooking>> {
    const r = await this.system.reservar(
      { taller: req.workshopRef, cupo: req.slotRef, cotizacion: req.externalQuoteRef, cliente: req.customerRef, vehiculo: req.vehicleRef },
      idempotencyKey,
    );
    return translate(r, booking);
  }

  async findBooking(idempotencyKey: string): Promise<WsResult<WsBooking | null>> {
    const r = await this.system.consultarReserva(idempotencyKey);
    if (r.status !== 200 && r.codigo === "RESERVA_INEXISTENTE") return { ok: true, data: null, source: "MOCK" };
    return translate(r, booking);
  }

  async cancelBooking(folio: string): Promise<WsResult<WsBooking>> {
    return translate(await this.system.cancelar(folio), booking);
  }

  async openWorkOrder(folio: string): Promise<WsResult<WsWorkOrder>> {
    return translate(await this.system.abrirOrden(folio), workOrder);
  }

  async completeWorkOrder(req: { workOrderRef: string; completionOdometerKm: number }): Promise<WsResult<WsWorkOrder>> {
    return translate(await this.system.cerrarOrden({ referencia: req.workOrderRef, kilometraje: req.completionOdometerKm }), workOrder);
  }
}
