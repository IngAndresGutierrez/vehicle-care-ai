import { getContainer } from "@/infra/container";
import { handleDemoSession } from "@/infra/http/handlers";

export async function POST(request: Request): Promise<Response> {
  return handleDemoSession(request, getContainer());
}
