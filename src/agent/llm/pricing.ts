/**
 * Tarifas USD por millón de tokens (referencia del SDK de Anthropic; verificar en la página oficial de precios).
 * Escritura de caché de 5 minutos = 1,25 × entrada. Se usan para el costo ESTIMADO por turno (observabilidad) y en
 * la evaluación; la facturación real es la de la consola de Anthropic.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Costo estimado en USD; null si el modelo no tiene tarifa conocida (p. ej. simulaciones). */
export function estimateCostUsd(model: string, u: TokenUsage): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadInputTokens * p.cacheRead + u.cacheCreationInputTokens * p.cacheWrite) / 1e6;
}
