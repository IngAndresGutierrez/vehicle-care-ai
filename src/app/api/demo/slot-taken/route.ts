import { getContainer } from "@/infra/container";
import { handleDemoSlotTaken } from "@/infra/http/view-handlers";

export async function POST(request: Request): Promise<Response> {
  return handleDemoSlotTaken(request, getContainer());
}
