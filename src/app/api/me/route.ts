import { connection } from "next/server";
import { getContainer } from "@/infra/container";
import { handleMe } from "@/infra/http/view-handlers";

export async function GET(request: Request): Promise<Response> {
  // Siempre por solicitud: nunca se ejecuta en el build (no requiere secretos ni base al compilar).
  await connection();
  return handleMe(request, getContainer());
}
