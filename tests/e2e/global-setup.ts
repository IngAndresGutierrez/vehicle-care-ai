import type { FullConfig } from "@playwright/test";

/**
 * Las pruebas E2E nunca deben consumir créditos: si el servidor (nuevo o reutilizado) usa un LLM real, se detienen.
 * Para probar a propósito contra un despliegue con Claude: E2E_ALLOW_REAL_LLM=1 (con presupuesto aprobado).
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const res = await fetch(`${baseURL}/api/demo/config`);
  const body = (await res.json()) as { llm?: { simulated?: boolean; model?: string } };
  // Modo real (E2E_REAL_LLM=1): exige que el servidor use de verdad Claude (no reutilizar uno simulado por error).
  if (process.env.E2E_REAL_LLM === "1") {
    if (body.llm?.simulated !== false) throw new Error("E2E_REAL_LLM=1 pero el servidor usa un LLM simulado: detén el servidor existente y vuelve a correr.");
    return;
  }
  if (process.env.E2E_ALLOW_REAL_LLM === "1") return;
  if (!body.llm?.simulated) {
    throw new Error(`El servidor de pruebas usa un LLM real (${body.llm?.model}). Reinícialo con LLM_PROVIDER=scripted o define E2E_ALLOW_REAL_LLM=1.`);
  }
}
