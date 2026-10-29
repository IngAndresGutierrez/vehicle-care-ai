import { getContainer } from "@/infra/container";
import { handleMe } from "@/infra/http/view-handlers";

export async function GET(request: Request): Promise<Response> {
  return handleMe(request, getContainer());
}
