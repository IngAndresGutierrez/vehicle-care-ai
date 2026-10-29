import { getContainer } from "@/infra/container";
import { handleDemoStart } from "@/infra/http/view-handlers";

export async function POST(request: Request): Promise<Response> {
  return handleDemoStart(request, getContainer());
}
