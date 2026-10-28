import { getContainer } from "@/infra/container";
import { handleBookingConfirm } from "@/infra/http/handlers";

export async function POST(request: Request): Promise<Response> {
  return handleBookingConfirm(request, getContainer());
}
