import { expect } from "vitest";

/** Texto completo de un error de Prisma/driver (mensaje + metadatos), para buscar restricciones por nombre. */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const meta = (error as { meta?: unknown }).meta;
  return `${error.message} ${meta ? JSON.stringify(meta) : ""}`;
}

/** La operación debe fallar en la base con un mensaje que contenga `pattern` (p. ej. el nombre del CHECK). */
export async function expectDbRejection(operation: Promise<unknown>, pattern: string | RegExp): Promise<void> {
  let caught: unknown = null;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, "se esperaba que la base rechazara la operación").not.toBeNull();
  expect(errorText(caught)).toMatch(pattern);
}
