import type { Db } from "@/infra/prisma";

/**
 * Inyección de fallos de los sistemas MOCK (ARCHITECTURE.md §7.3), persistida en `MockScenario`.
 * Un escenario activo con `remainingUses` se consume de forma atómica; con `remainingUses = null` es permanente.
 */
export type MockScenarioKey =
  | "WORKSHOP_DOWN" // el taller rechaza toda solicitud sin procesarla
  | "QUOTE_UNAVAILABLE" // el catálogo no devuelve precio
  | "SLOT_CONFLICT_ON_NEXT_BOOKING" // el cupo desaparece justo antes de reservar
  | "BOOKING_TIMEOUT_AFTER_COMMIT" // el taller crea la reserva pero la respuesta se pierde
  | "BOOKING_TIMEOUT_BEFORE_COMMIT" // la solicitud se pierde antes de procesarse
  | "CRM_DOWN"; // el CRM no responde

/** Devuelve true si el escenario está activo y, si tiene usos limitados, consume uno. */
export async function consumeScenario(db: Db, key: MockScenarioKey): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "MockScenario"
       SET "remainingUses" = CASE WHEN "remainingUses" IS NULL THEN NULL ELSE "remainingUses" - 1 END
     WHERE "key" = ${key} AND "isActive" AND ("remainingUses" IS NULL OR "remainingUses" > 0)
    RETURNING "id"`;
  return rows.length > 0;
}

/** Utilidad para demo y tests: activa un escenario (`uses = null` → permanente). */
export async function activateScenario(db: Db, key: MockScenarioKey, uses: number | null = 1): Promise<void> {
  await db.mockScenario.upsert({
    where: { key },
    create: { key, isActive: true, remainingUses: uses },
    update: { isActive: true, remainingUses: uses },
  });
}

export async function deactivateScenario(db: Db, key: MockScenarioKey): Promise<void> {
  await db.mockScenario.updateMany({ where: { key }, data: { isActive: false } });
}
