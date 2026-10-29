import { connection } from "next/server";
import { getContainer } from "@/infra/container";
import { handleDemoConfig } from "@/infra/http/view-handlers";

export async function GET(request: Request): Promise<Response> {
  // Depende del entorno en ejecución (DEMO_MODE, LLM_PROVIDER): nunca se prerenderiza en el build.
  await connection();
  return handleDemoConfig(request, getContainer());
}
