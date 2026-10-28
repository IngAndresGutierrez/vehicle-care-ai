import { randomUUID } from "node:crypto";

/** Identificador de traza por turno/operación (ARCHITECTURE.md §9). */
export const newTraceId = (): string => `trc_${randomUUID()}`;

export interface IdGenerator {
  next(prefix: string): string;
}

export const uuidIdGenerator: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID()}` };
