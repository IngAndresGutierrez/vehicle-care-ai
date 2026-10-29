import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Card } from "@/agent/cards";
import type { TurnResult } from "@/agent/maintenance-advisor";
import { confirmBooking } from "@/application/booking/confirm-booking";
import { simulateSlotTaken } from "@/application/demo/demo-runs";
import { getVehicleOverview } from "@/application/views/read-models";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { runJob, say } from "./helpers/agent";
import { depsAt, OIL, OWNER_C1 } from "./helpers/booking-flow";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const { vehicles: V } = DEMO_IDS;
const intentOf = (r: TurnResult) => r.cards.find((c) => c.type === "BOOKING_INTENT") as Extract<Card, { type: "BOOKING_INTENT" }> | undefined;
const overview = async () => {
  const o = await getVehicleOverview(depsAt(db), { actor: OWNER_C1, vehicleId: V.v1, serviceCode: OIL });
  if (!o.ok) throw new Error("overview");
  return o.value;
};

async function toIntent(): Promise<TurnResult> {
  let s = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
  s = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: s.sessionId });
  s = await say(db, OWNER_C1, V.v1, "¿Qué horarios hay?", { sessionId: s.sessionId });
  return say(db, OWNER_C1, V.v1, "Reserva el primer horario", { sessionId: s.sessionId });
}

beforeEach(async () => {
  await resetAndSeed(db);
  await runJob(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("Inyección de fallos operativos (Fase 8C)", () => {
  it("se pierde la respuesta tras preparar la reserva: en una sesión nueva la tarjeta se reentrega con token nuevo; el viejo no sirve; una sola reserva", async () => {
    const lost = await toIntent();
    const oldToken = intentOf(lost)!.confirmationToken!;
    // El cliente nunca recibió esa respuesta y vuelve sin sesión (o tras una caída del proceso).
    const back = await say(db, OWNER_C1, V.v1, "Hola, ¿cómo va mi reserva?");
    expect(back.sessionId).not.toBe(lost.sessionId);
    expect(back.trace.flags).toContain("INTENT_REDELIVERED");
    const card = intentOf(back)!;
    expect(card.intentId).toBe(intentOf(lost)!.intentId); // la MISMA intención, no otra
    expect(card.confirmationToken).toBeTruthy();
    expect(card.confirmationToken).not.toBe(oldToken);
    expect(await db.bookingIntent.count({ where: { vehicleId: V.v1 } })).toBe(1);
    expect((await overview()).pendingIntent?.intentId).toBe(card.intentId); // tarjeta coherente con la base

    const stale = await confirmBooking(depsAt(db), { actor: OWNER_C1, confirmationToken: oldToken, traceId: "c-old" });
    expect(stale.ok ? "OK" : stale.error.code).toBe("INVALID_TOKEN");
    const okConfirm = await confirmBooking(depsAt(db), { actor: OWNER_C1, confirmationToken: card.confirmationToken!, traceId: "c-new" });
    expect(okConfirm.ok && okConfirm.value.status).toBe("CONFIRMED");
    expect(await db.booking.count({ where: { vehicleId: V.v1 } })).toBe(1);
    expect((await overview()).booking?.status).toBe("CONFIRMED");
  });

  it("el usuario reintenta el mismo turno: no se crea otra intención ni se reserva nada", async () => {
    const first = await toIntent();
    const retry = await say(db, OWNER_C1, V.v1, "Reserva el primer horario", { sessionId: first.sessionId });
    expect(retry.trace.toolCalls.filter((t) => t.tool === "prepareBooking" && t.ok)).toHaveLength(0);
    expect(await db.bookingIntent.count({ where: { vehicleId: V.v1 } })).toBe(1);
    expect(await db.booking.count({ where: { vehicleId: V.v1 } })).toBe(0);
  });

  it("la cotización caduca durante la conversación: no se prepara la reserva y se puede volver a cotizar", async () => {
    let s = await say(db, OWNER_C1, V.v1, "¿Qué mantenimiento le toca a mi carro?");
    s = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: s.sessionId });
    s = await say(db, OWNER_C1, V.v1, "¿Qué horarios hay?", { sessionId: s.sessionId });
    const quote = await db.quote.findFirstOrThrow({ where: { vehicleId: V.v1 }, orderBy: { createdAt: "desc" } });
    const minutesLater = Math.ceil((quote.validUntil!.getTime() - DEMO_NOW.getTime()) / 60_000) + 5;
    const late = await say(db, OWNER_C1, V.v1, "Reserva el primer horario", { sessionId: s.sessionId, minutes: minutesLater });
    // Con la cotización vencida (y la memoria ya depurada) no se prepara nada: ni con el modelo ni por el gateway.
    expect(intentOf(late)).toBeUndefined();
    expect(late.trace.toolCalls.some((t) => t.tool === "prepareBooking" && t.ok)).toBe(false);
    expect(await db.bookingIntent.count({ where: { vehicleId: V.v1 } })).toBe(0);
    const requote = await say(db, OWNER_C1, V.v1, "¿Cuánto cuesta?", { sessionId: late.sessionId, minutes: minutesLater });
    expect(requote.cards.some((c) => c.type === "QUOTE")).toBe(true);
  });

  it("el horario queda ocupado antes de confirmar: SLOT_CONFLICT sin reserva; la recuperación termina con una sola reserva confirmada", async () => {
    const r = await toIntent();
    await simulateSlotTaken(depsAt(db), { actor: OWNER_C1, traceId: "t-taken" });
    const conflict = await confirmBooking(depsAt(db), { actor: OWNER_C1, confirmationToken: intentOf(r)!.confirmationToken!, traceId: "c1" });
    expect(conflict.ok ? "OK" : conflict.error.code).toBe("SLOT_CONFLICT");
    expect(await db.booking.count({ where: { vehicleId: V.v1, status: "CONFIRMED" } })).toBe(0);
    let s = await say(db, OWNER_C1, V.v1, "¿Qué horarios hay?", { sessionId: r.sessionId });
    s = await say(db, OWNER_C1, V.v1, "Reserva el primer horario", { sessionId: s.sessionId });
    const ok = await confirmBooking(depsAt(db), { actor: OWNER_C1, confirmationToken: intentOf(s)!.confirmationToken!, traceId: "c2" });
    expect(ok.ok && ok.value.status).toBe("CONFIRMED");
    expect(await db.booking.count({ where: { vehicleId: V.v1, status: "CONFIRMED" } })).toBe(1);
    expect((await overview()).booking?.status).toBe("CONFIRMED");
  });

  it("la sesión vence durante el journey: la sesión nueva reentrega la reserva pendiente", async () => {
    const r = await toIntent();
    await db.$executeRaw`UPDATE "ConversationSession" SET "lastActiveAt" = ${new Date(DEMO_NOW.getTime() - 5 * 3_600_000)} WHERE id = ${r.sessionId}`;
    const back = await say(db, OWNER_C1, V.v1, "Ya volví", { sessionId: r.sessionId });
    expect(back.sessionId).not.toBe(r.sessionId);
    expect(intentOf(back)?.intentId).toBe(intentOf(r)!.intentId);
    expect(await db.bookingIntent.count({ where: { vehicleId: V.v1 } })).toBe(1);
  });
});
