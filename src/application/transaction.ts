import type { Prisma } from "@/generated/prisma/client";
import { err, type Result } from "@/domain/shared/result";
import type { Db } from "@/infra/prisma";

export type Tx = Prisma.TransactionClient;

/** Fuerza el rollback de la transacción llevando consigo el error de negocio. */
class TxAbort<E> extends Error {
  constructor(readonly error: E) {
    super("transaction aborted");
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  return e.code === "P2002" || (typeof e.message === "string" && /Unique constraint|duplicate key value/i.test(e.message));
}

export interface RetryableError {
  code: string;
  retryable?: boolean;
}

/**
 * Ejecuta `fn` en una transacción. Un error de negocio revierte todo lo escrito. Los conflictos de
 * concurrencia (versión optimista con `retryable: true` o violación de unicidad por una carrera) se
 * reintentan releyendo el estado; al reintentar, las claves de idempotencia convierten la carrera en DUPLICATE.
 */
export async function runInTransaction<T, E extends RetryableError>(
  db: Db,
  fn: (tx: Tx) => Promise<Result<T, E>>,
  { maxAttempts = 8 }: { maxAttempts?: number } = {},
): Promise<Result<T, E>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const result = await fn(tx);
        if (!result.ok) throw new TxAbort(result.error);
        return result;
      });
    } catch (error) {
      if (error instanceof TxAbort) {
        const e = error.error as E;
        if (e.retryable && attempt < maxAttempts) {
          await backoff(attempt);
          continue;
        }
        return err(e);
      }
      if (isUniqueViolation(error) && attempt < maxAttempts) {
        await backoff(attempt);
        continue;
      }
      throw error;
    }
  }
}

/** Espera breve con jitter para que transacciones en conflicto no vuelvan a chocar en el mismo instante. */
function backoff(attempt: number): Promise<void> {
  const ms = Math.random() * 5 * attempt;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
