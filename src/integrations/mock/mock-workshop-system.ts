import { createHash, randomUUID } from "node:crypto";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { consumeScenario } from "./mock-scenarios";

/**
 * ⚠️ SISTEMA DE TALLER SIMULADO (MOCK). No existe ningún taller real detrás.
 *
 * Imita la API de un proveedor externo: códigos propios en español, estado persistente en PostgreSQL
 * (tablas Mock*) y transacciones propias, independientes de las de Vehicle Care. El dominio nunca lo usa
 * directamente: lo hace a través de `MockWorkshopAdapter` (capa anticorrupción).
 */

export type RawErrorCode =
  | "SERVICIO_NO_DISPONIBLE"
  | "TIEMPO_AGOTADO"
  | "SIN_TARIFA"
  | "SIN_CUPOS"
  | "CUPO_NO_DISPONIBLE"
  | "CUPO_INEXISTENTE"
  | "COTIZACION_VENCIDA"
  | "COTIZACION_INEXISTENTE"
  | "CLAVE_REUTILIZADA"
  | "RESERVA_INEXISTENTE"
  | "ORDEN_INEXISTENTE"
  | "ESTADO_INVALIDO";

export type RawResponse<T> = { status: 200; body: T } | { status: 404 | 409 | 410 | 422 | 503 | 504; codigo: RawErrorCode };

export interface RawQuote {
  referencia: string;
  subtotal: number;
  iva: number;
  total: number;
  etiquetaImpuesto: string;
  items: Array<{ descripcion: string; cantidad: number }>;
  restricciones: string[];
  versionCatalogo: string;
  esEstimado: boolean;
  validoHasta: string;
}
export interface RawSlot {
  cupo: string;
  inicio: string;
  fin: string;
  disponibles: number;
}
export interface RawBooking {
  folio: string;
  cupo: string;
  inicio: string;
  estado: "CONFIRMED" | "CANCELLED";
}
export interface RawWorkOrder {
  referencia: string;
  folioReserva: string;
  estado: "OPEN" | "COMPLETED";
  kilometrajeCierre: number | null;
}

const fail = (status: 404 | 409 | 410 | 422 | 503 | 504, codigo: RawErrorCode) => ({ status, codigo }) as const;

export class MockWorkshopSystem {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private async down(): Promise<boolean> {
    return consumeScenario(this.db, "WORKSHOP_DOWN");
  }

  async cotizar(req: { taller: string; servicio: string; specKey: string }): Promise<RawResponse<RawQuote>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    if (await consumeScenario(this.db, "QUOTE_UNAVAILABLE")) return fail(404, "SIN_TARIFA");
    const price = await this.db.mockCatalogPrice.findUnique({
      where: { workshopExternalRef_externalServiceCode_specKey: { workshopExternalRef: req.taller, externalServiceCode: req.servicio, specKey: req.specKey } },
    });
    if (!price) return fail(404, "SIN_TARIFA");
    const now = this.clock.now();
    const quote = await this.db.mockQuote.create({
      data: {
        externalRef: `COT-${req.taller}-${randomUUID().slice(0, 8).toUpperCase()}`,
        workshopExternalRef: req.taller,
        externalServiceCode: req.servicio,
        specKey: req.specKey,
        subtotalCop: price.subtotalCop,
        taxCop: price.taxCop,
        totalCop: price.subtotalCop + price.taxCop,
        catalogVersion: price.catalogVersion,
        validUntil: new Date(now.getTime() + price.validityHours * 3_600_000),
        createdAt: now,
      },
    });
    return {
      status: 200,
      body: {
        referencia: quote.externalRef,
        subtotal: quote.subtotalCop,
        iva: quote.taxCop,
        total: quote.totalCop,
        etiquetaImpuesto: price.taxLabel,
        items: (price.includedItems as Array<{ descripcion: string; cantidad: number }>) ?? [],
        restricciones: price.restrictions,
        versionCatalogo: price.catalogVersion,
        esEstimado: price.isEstimate,
        validoHasta: quote.validUntil.toISOString(),
      },
    };
  }

  async cupos(req: { taller: string; servicio: string; desde: Date; hasta: Date }): Promise<RawResponse<RawSlot[]>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    const slots = await this.db.mockSlot.findMany({
      where: { workshopExternalRef: req.taller, externalServiceCode: req.servicio, remaining: { gt: 0 }, startsAt: { gte: req.desde, lt: req.hasta } },
      orderBy: { startsAt: "asc" },
    });
    if (slots.length === 0) return fail(404, "SIN_CUPOS");
    return { status: 200, body: slots.map(toRawSlot) };
  }

  async cupo(req: { taller: string; cupo: string }): Promise<RawResponse<RawSlot>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    const slot = await this.db.mockSlot.findFirst({ where: { id: req.cupo, workshopExternalRef: req.taller } });
    return slot ? { status: 200, body: toRawSlot(slot) } : fail(404, "CUPO_INEXISTENTE");
  }

  async reservar(
    req: { taller: string; cupo: string; cotizacion: string; cliente: string; vehiculo: string },
    claveIdempotencia: string,
  ): Promise<RawResponse<RawBooking>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    if (await consumeScenario(this.db, "BOOKING_TIMEOUT_BEFORE_COMMIT")) return fail(504, "TIEMPO_AGOTADO");

    const requestHash = createHash("sha256").update(JSON.stringify([req.taller, req.cupo, req.cotizacion, req.vehiculo])).digest("hex");
    const existing = await this.existingByKey(claveIdempotencia, requestHash);
    if (existing) return existing;

    if (await consumeScenario(this.db, "SLOT_CONFLICT_ON_NEXT_BOOKING")) return fail(409, "CUPO_NO_DISPONIBLE");

    const now = this.clock.now();
    const quote = await this.db.mockQuote.findUnique({ where: { externalRef: req.cotizacion } });
    if (!quote || quote.workshopExternalRef !== req.taller) return fail(404, "COTIZACION_INEXISTENTE");
    if (quote.validUntil.getTime() <= now.getTime()) return fail(410, "COTIZACION_VENCIDA");

    let created: RawBooking;
    try {
      created = await this.db.$transaction(async (tx) => {
        // Operación atómica: dos reservas sobre el último cupo no pueden ganar ambas.
        const taken = await tx.$executeRaw`
          UPDATE "MockSlot" SET "remaining" = "remaining" - 1
           WHERE "id" = ${req.cupo} AND "workshopExternalRef" = ${req.taller} AND "remaining" > 0`;
        if (taken !== 1) throw new SlotUnavailable();
        const slot = await tx.mockSlot.findUniqueOrThrow({ where: { id: req.cupo } });
        const booking = await tx.mockBooking.create({
          data: {
            folio: `FOLIO-${req.taller}-${randomUUID().slice(0, 8).toUpperCase()}`,
            slotId: req.cupo,
            externalQuoteRef: req.cotizacion,
            idempotencyKey: claveIdempotencia,
            requestHash,
            workshopExternalRef: req.taller,
            vehicleRef: req.vehiculo,
            customerRef: req.cliente,
            createdAt: now,
          },
        });
        return { folio: booking.folio, cupo: slot.id, inicio: slot.startsAt.toISOString(), estado: "CONFIRMED" as const };
      });
    } catch (error) {
      if (error instanceof SlotUnavailable) {
        const slot = await this.db.mockSlot.findFirst({ where: { id: req.cupo, workshopExternalRef: req.taller } });
        return fail(slot ? 409 : 404, slot ? "CUPO_NO_DISPONIBLE" : "CUPO_INEXISTENTE");
      }
      // Carrera con la misma clave: la otra solicitud ganó; responder con su resultado.
      const raced = await this.existingByKey(claveIdempotencia, requestHash);
      if (raced) return raced;
      throw error;
    }

    // La reserva quedó creada, pero el cliente no recibe la respuesta: resultado incierto.
    if (await consumeScenario(this.db, "BOOKING_TIMEOUT_AFTER_COMMIT")) return fail(504, "TIEMPO_AGOTADO");
    return { status: 200, body: created };
  }

  async consultarReserva(claveIdempotencia: string): Promise<RawResponse<RawBooking>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    const booking = await this.db.mockBooking.findUnique({ where: { idempotencyKey: claveIdempotencia } });
    return booking ? { status: 200, body: await this.toRawBooking(booking) } : fail(404, "RESERVA_INEXISTENTE");
  }

  async cancelar(folio: string): Promise<RawResponse<RawBooking>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    const result = await this.db.$transaction(async (tx) => {
      const booking = await tx.mockBooking.findUnique({ where: { folio } });
      if (!booking) return null;
      if (booking.status === "CONFIRMED") {
        await tx.mockBooking.update({ where: { folio }, data: { status: "CANCELLED", cancelledAt: this.clock.now() } });
        await tx.$executeRaw`UPDATE "MockSlot" SET "remaining" = LEAST("remaining" + 1, "capacity") WHERE "id" = ${booking.slotId}`;
      }
      return tx.mockBooking.findUniqueOrThrow({ where: { folio } });
    });
    return result ? { status: 200, body: await this.toRawBooking(result) } : fail(404, "RESERVA_INEXISTENTE");
  }

  async abrirOrden(folio: string): Promise<RawResponse<RawWorkOrder>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    const booking = await this.db.mockBooking.findUnique({ where: { folio } });
    if (!booking) return fail(404, "RESERVA_INEXISTENTE");
    if (booking.status !== "CONFIRMED") return fail(422, "ESTADO_INVALIDO");
    const order = await this.db.mockWorkOrder.upsert({
      where: { mockBookingId: booking.id },
      create: { folio: `OT-${randomUUID().slice(0, 8).toUpperCase()}`, mockBookingId: booking.id, status: "OPEN", createdAt: this.clock.now() },
      update: {},
    });
    return { status: 200, body: { referencia: order.folio, folioReserva: folio, estado: order.status as "OPEN", kilometrajeCierre: null } };
  }

  async cerrarOrden(req: { referencia: string; kilometraje: number }): Promise<RawResponse<RawWorkOrder>> {
    if (await this.down()) return fail(503, "SERVICIO_NO_DISPONIBLE");
    const order = await this.db.mockWorkOrder.findUnique({ where: { folio: req.referencia } });
    if (!order) return fail(404, "ORDEN_INEXISTENTE");
    const booking = await this.db.mockBooking.findUniqueOrThrow({ where: { id: order.mockBookingId } });
    if (order.status === "COMPLETED") {
      // Cierre idempotente con los mismos datos.
      return order.completionOdometerKm === req.kilometraje
        ? { status: 200, body: { referencia: order.folio, folioReserva: booking.folio, estado: "COMPLETED", kilometrajeCierre: order.completionOdometerKm } }
        : fail(422, "ESTADO_INVALIDO");
    }
    const closed = await this.db.mockWorkOrder.update({
      where: { folio: req.referencia },
      data: { status: "COMPLETED", completedAt: this.clock.now(), completionOdometerKm: req.kilometraje },
    });
    return { status: 200, body: { referencia: closed.folio, folioReserva: booking.folio, estado: "COMPLETED", kilometrajeCierre: req.kilometraje } };
  }

  private async existingByKey(key: string, requestHash: string): Promise<RawResponse<RawBooking> | null> {
    const existing = await this.db.mockBooking.findUnique({ where: { idempotencyKey: key } });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) return fail(422, "CLAVE_REUTILIZADA");
    return { status: 200, body: await this.toRawBooking(existing) };
  }

  private async toRawBooking(b: { folio: string; slotId: string; status: string }): Promise<RawBooking> {
    const slot = await this.db.mockSlot.findUnique({ where: { id: b.slotId } });
    return { folio: b.folio, cupo: b.slotId, inicio: slot?.startsAt.toISOString() ?? "", estado: b.status as "CONFIRMED" | "CANCELLED" };
  }
}

class SlotUnavailable extends Error {}

function toRawSlot(s: { id: string; startsAt: Date; endsAt: Date; remaining: number }): RawSlot {
  return { cupo: s.id, inicio: s.startsAt.toISOString(), fin: s.endsAt.toISOString(), disponibles: s.remaining };
}
