import { getContainer } from "@/infra/container";
import { handleResolveCase } from "@/infra/http/view-handlers";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleResolveCase(request, getContainer(), (await params).id);
}
