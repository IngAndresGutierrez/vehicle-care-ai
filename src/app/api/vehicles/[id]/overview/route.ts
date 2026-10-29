import { getContainer } from "@/infra/container";
import { handleVehicleOverview } from "@/infra/http/view-handlers";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleVehicleOverview(request, getContainer(), (await params).id);
}
