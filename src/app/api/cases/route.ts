import { getContainer } from "@/infra/container";
import { handleCases } from "@/infra/http/view-handlers";

export async function GET(request: Request): Promise<Response> {
  return handleCases(request, getContainer());
}
