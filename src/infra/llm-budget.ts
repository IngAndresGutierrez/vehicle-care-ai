import { MODEL_PRICES } from "@/agent/llm/pricing";
import type { Db } from "./prisma";

/** Tarifa más cara conocida: estima de forma conservadora los turnos reales sin costo registrado (modelo sin tarifa). */
const WORST = Object.values(MODEL_PRICES).reduce((a, p) => ({
  input: Math.max(a.input, p.input),
  output: Math.max(a.output, p.output),
  cacheRead: Math.max(a.cacheRead, p.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, p.cacheWrite),
}));

/**
 * Gasto ESTIMADO del LLM real en las últimas 24 h, sumado desde las métricas por turno (`ConversationMessage.metrics`).
 * Se cuenta en la base para que valga entre reinicios e instancias. Solo turnos con proveedor real (no ScriptedLlm).
 */
export async function llmSpentLast24hUsd(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000);
  const rows = await db.$queryRaw<Array<{ usd: number | null }>>`
    SELECT SUM(COALESCE(
      (metrics->'llm'->>'costUsd')::float8,
      (COALESCE((metrics->'llm'->>'inputTokens')::float8, 0) * ${WORST.input}
        + COALESCE((metrics->'llm'->>'outputTokens')::float8, 0) * ${WORST.output}
        + COALESCE((metrics->'llm'->>'cacheReadInputTokens')::float8, 0) * ${WORST.cacheRead}
        + COALESCE((metrics->'llm'->>'cacheCreationInputTokens')::float8, 0) * ${WORST.cacheWrite}) / 1e6
    ))::float8 AS usd
    FROM "ConversationMessage"
    WHERE "createdAt" > ${since} AND metrics->'llm'->>'provider' = 'ANTHROPIC'`;
  return rows[0]?.usd ?? 0;
}
