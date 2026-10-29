import { getContainer } from "@/infra/container";
import { handleVehicleTrace } from "@/infra/http/view-handlers";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleVehicleTrace(request, getContainer(), (await params).id);
}
