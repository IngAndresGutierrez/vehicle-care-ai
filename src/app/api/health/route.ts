import { connection } from "next/server";
import { handleHealth } from "@/infra/http/health";
import { getPrisma } from "@/infra/prisma";

export async function GET(): Promise<Response> {
  // Siempre por solicitud: el health check refleja el estado real del proceso y de PostgreSQL.
  await connection();
  return handleHealth(getPrisma);
}
