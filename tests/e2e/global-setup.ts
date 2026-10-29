import type { FullConfig } from "@playwright/test";

/**
 * Las pruebas E2E nunca deben consumir créditos: si el servidor (nuevo o reutilizado) usa un LLM real, se detienen.
 * Para probar a propósito contra un despliegue con Claude: E2E_ALLOW_REAL_LLM=1 (con presupuesto aprobado).
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL || process.env.E2E_ALLOW_REAL_LLM === "1") return;
  const res = await fetch(`${baseURL}/api/demo/config`);
  const body = (await res.json()) as { llm?: { simulated?: boolean; model?: string } };
  if (!body.llm?.simulated) {
    throw new Error(`El servidor de pruebas usa un LLM real (${body.llm?.model}). Reinícialo con LLM_PROVIDER=scripted o define E2E_ALLOW_REAL_LLM=1.`);
  }
}
