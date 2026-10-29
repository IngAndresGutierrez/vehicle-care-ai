import { randomUUID } from "node:crypto";
import type { Db } from "@/infra/prisma";

/**
 * Lease de turno con fencing token y hora de la BASE (Fase 8C, ADR-023).
 * - La propiedad la define `turnLeaseId` (único por turno); el vencimiento solo habilita que otro turno lo tome.
 * - Todo se compara con `now()` de PostgreSQL: no depende del reloj de cada instancia.
 * - `renew()` antes de cada paso (LLM o herramienta): si otro turno tomó la sesión, este se detiene sin ejecutar más.
 * - La escritura del turno (persist) exige el mismo `turnLeaseId`: un turno desplazado nunca escribe fuera de orden.
 */
export class TurnLease {
  private constructor(
    private readonly db: Db,
    readonly sessionId: string,
    readonly leaseId: string,
    private readonly ttlMs: number,
  ) {}

  static async acquire(db: Db, sessionId: string, ttlMs: number): Promise<TurnLease | null> {
    const leaseId = randomUUID();
    const n = await db.$executeRaw`
      UPDATE "ConversationSession"
         SET "turnLeaseId" = ${leaseId}, "turnLockedUntil" = now() + (${ttlMs} * interval '1 millisecond')
       WHERE "id" = ${sessionId} AND ("turnLockedUntil" IS NULL OR "turnLockedUntil" < now())`;
    return n === 1 ? new TurnLease(db, sessionId, leaseId, ttlMs) : null;
  }

  /** Extiende el lease si sigue siendo de este turno (aunque haya vencido, mientras nadie lo haya tomado). */
  async renew(): Promise<boolean> {
    const n = await this.db.$executeRaw`
      UPDATE "ConversationSession" SET "turnLockedUntil" = now() + (${this.ttlMs} * interval '1 millisecond')
       WHERE "id" = ${this.sessionId} AND "turnLeaseId" = ${this.leaseId}`;
    return n === 1;
  }

  /** Libera solo si sigue siendo de este turno: nunca libera el lease de otro. */
  async release(): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "ConversationSession" SET "turnLeaseId" = NULL, "turnLockedUntil" = NULL
       WHERE "id" = ${this.sessionId} AND "turnLeaseId" = ${this.leaseId}`;
  }
}
