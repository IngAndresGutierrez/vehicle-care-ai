import { getContainer } from "@/infra/container";
import { handleAgentTurn } from "@/infra/http/handlers";

export async function POST(request: Request): Promise<Response> {
  return handleAgentTurn(request, getContainer());
}
