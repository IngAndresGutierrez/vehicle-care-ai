import { connection } from "next/server";
import { getContainer } from "@/infra/container";
import { handleVehicleTrace } from "@/infra/http/view-handlers";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  // Siempre por solicitud: nunca se ejecuta en el build (no requiere secretos ni base al compilar).
  await connection();
  return handleVehicleTrace(request, getContainer(), (await params).id);
}
