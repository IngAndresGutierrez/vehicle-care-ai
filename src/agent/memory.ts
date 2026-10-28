import { z } from "zod";

/**
 * Memoria estructurada por sesión y vehículo (AGENT_DESIGN.md §7). No es fuente técnica: cada entrada caduca y,
 * al vencer, el agente debe volver a consultar. Nunca contiene PII ni tokens de confirmación.
 */
const isoDate = z.string();

export const AdvisorMemorySchema = z.object({
  lastEvaluation: z
    .object({
      evaluationId: z.string(),
      status: z.string(),
      suggestedAction: z.string(),
      dueByKm: z.number().nullable(),
      dueByDate: z.string().nullable(),
      remainingKm: z.number().nullable(),
      remainingDays: z.number().nullable(),
      planVersion: z.string().nullable(),
      sourceRef: z.string().nullable(),
      synthetic: z.boolean(),
      expiresAt: isoDate,
    })
    .nullable()
    .default(null),
  plan: z
    .object({ version: z.string(), intervals: z.array(z.object({ serviceCode: z.string(), intervalKm: z.number().nullable(), intervalMonths: z.number().nullable() })), expiresAt: isoDate })
    .nullable()
    .default(null),
  knownKm: z.array(z.number()).default([]),
  workshops: z.array(z.object({ workshopId: z.string(), name: z.string() })).default([]),
  activeQuote: z
    .object({ quoteId: z.string(), workshopId: z.string(), subtotalCop: z.number(), taxCop: z.number(), totalCop: z.number(), validUntil: isoDate, source: z.string() })
    .nullable()
    .default(null),
  offeredSlots: z.array(z.object({ slotRef: z.string(), startsAt: isoDate, workshopId: z.string() })).default([]),
  pendingIntent: z.object({ intentId: z.string(), expiresAt: isoDate }).nullable().default(null),
  openCaseRefs: z.array(z.string()).default([]),
  /** El usuario no vio la última respuesta del modelo: el validador la reemplazó. */
  previousResponseBlocked: z.boolean().default(false),
});

export type AdvisorMemory = z.infer<typeof AdvisorMemorySchema>;

export function parseMemory(raw: unknown): AdvisorMemory {
  const parsed = AdvisorMemorySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : AdvisorMemorySchema.parse({});
}

/** Elimina entradas caducadas: lo vencido no puede usarse como dato. */
export function pruneMemory(memory: AdvisorMemory, now: Date): AdvisorMemory {
  const alive = (iso: string) => new Date(iso).getTime() > now.getTime();
  return {
    ...memory,
    lastEvaluation: memory.lastEvaluation && alive(memory.lastEvaluation.expiresAt) ? memory.lastEvaluation : null,
    plan: memory.plan && alive(memory.plan.expiresAt) ? memory.plan : null,
    activeQuote: memory.activeQuote && alive(memory.activeQuote.validUntil) ? memory.activeQuote : null,
    offeredSlots: memory.offeredSlots.filter((s) => alive(s.startsAt)),
    pendingIntent: memory.pendingIntent && alive(memory.pendingIntent.expiresAt) ? memory.pendingIntent : null,
  };
}
