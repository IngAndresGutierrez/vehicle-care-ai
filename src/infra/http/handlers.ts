import { z } from "zod";
import { confirmBooking } from "@/application/booking/confirm-booking";
import type { ActorContext } from "@/domain/policies/access-policy";
import type { Container } from "../container";
import { newTraceId } from "../ids";
import { readCookie, SESSION_COOKIE, signSession, verifySession } from "../session";

const MAX_BODY_BYTES = 8 * 1024;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const problem = (status: number, code: string, message: string, traceId: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message }, traceId }, { "x-trace-id": traceId, ...headers });

export async function readJson(request: Request, traceId: string): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return { ok: false, response: problem(415, "UNSUPPORTED_MEDIA_TYPE", "Se espera application/json.", traceId) };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return { ok: false, response: problem(413, "PAYLOAD_TOO_LARGE", "La solicitud es demasiado grande.", traceId) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: problem(400, "INVALID_JSON", "JSON inválido.", traceId) };
  }
}

/** Resuelve el actor desde la cookie firmada; los permisos se recalculan en el servidor. */
export async function authenticate(request: Request, c: Container): Promise<ActorContext | null> {
  const claims = verifySession(readCookie(request.headers.get("cookie"), SESSION_COOKIE), c.sessionSecret, c.clock.now());
  if (!claims) return null;
  const account = await c.db.actorAccount.findUnique({ where: { id: claims.actorId } });
  return account ? { actorId: account.id, role: account.role, customerId: account.customerId, workshopId: account.workshopId } : null;
}

const TurnBody = z
  .object({
    vehicleId: z.string().min(1).max(80),
    serviceCode: z.enum(["ENGINE_OIL_FILTER", "TIMING_BELT"]).optional(),
    sessionId: z.string().min(1).max(80).optional(),
    message: z.string().min(1).max(2000),
  })
  .strict();

/** POST /api/agent/turn — un turno conversacional del propietario autenticado. */
export async function handleAgentTurn(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Inicia sesión para usar el asistente.", traceId);
  if (actor.role !== "OWNER") return problem(403, "OWNER_SESSION_REQUIRED", "El asistente atiende solo a propietarios.", traceId);
  const limit = c.turnLimiter.check(`turn:${actor.actorId}`, c.clock.now());
  if (!limit.allowed) return problem(429, "RATE_LIMITED", "Demasiados mensajes; espera un momento.", traceId, { "retry-after": String(limit.retryAfterSeconds) });

  const body = await readJson(request, traceId);
  if (!body.ok) return body.response;
  const parsed = TurnBody.safeParse(body.body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "Campos inválidos o no permitidos.", traceId);

  const result = await c.advisor.handleTurn({ owner: actor, ...parsed.data, traceId });
  if (!result.ok) return problem(result.error.status, result.error.code, result.error.message, traceId);
  return json(200, result.value, { "x-trace-id": traceId });
}

const ConfirmBody = z.object({ confirmationToken: z.string().min(20).max(200) }).strict();

/**
 * POST /api/bookings/confirm — el clic humano «Confirmar reserva». Fuera del LLM: solo el propietario
 * autenticado (o un asesor autorizado) con el token de la tarjeta. El agente no tiene acceso a esta ruta.
 */
export async function handleBookingConfirm(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Inicia sesión para confirmar.", traceId);
  const limit = c.confirmLimiter.check(`confirm:${actor.actorId}`, c.clock.now());
  if (!limit.allowed) return problem(429, "RATE_LIMITED", "Demasiados intentos; espera un momento.", traceId, { "retry-after": String(limit.retryAfterSeconds) });
  const body = await readJson(request, traceId);
  if (!body.ok) return body.response;
  const parsed = ConfirmBody.safeParse(body.body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "Token ausente o inválido.", traceId);

  const result = await confirmBooking(c.booking, { actor, confirmationToken: parsed.data.confirmationToken, traceId });
  if (!result.ok) {
    const status = result.error.code === "UNAUTHORIZED" || result.error.code === "AGENT_CANNOT_CONFIRM" ? 403 : result.error.code === "INVALID_TOKEN" ? 404 : 409;
    return json(status, { error: { code: result.error.code, retryable: result.error.retryable ?? false, refs: result.error.refs ?? {} }, traceId }, { "x-trace-id": traceId });
  }
  return json(200, { booking: result.value, traceId }, { "x-trace-id": traceId });
}

const DemoBody = z.object({ actorId: z.string().min(1).max(80) }).strict();

/** POST /api/demo/session — sesión SIMULADA para la demo (solo con DEMO_MODE=true). */
export async function handleDemoSession(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  if (!c.demoMode) return problem(404, "NOT_FOUND", "No disponible.", traceId);
  const body = await readJson(request, traceId);
  if (!body.ok) return body.response;
  const parsed = DemoBody.safeParse(body.body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "actorId requerido.", traceId);
  const account = await c.db.actorAccount.findUnique({ where: { id: parsed.data.actorId } });
  if (!account || !account.isDemo) return problem(404, "NOT_FOUND", "Persona demo inexistente.", traceId);
  const ttlSeconds = 8 * 3600;
  const token = signSession({ actorId: account.id, exp: Math.floor(c.clock.now().getTime() / 1000) + ttlSeconds }, c.sessionSecret);
  const cookie = sessionCookie(token, ttlSeconds);
  return json(200, { actorId: account.id, role: account.role, displayName: account.displayName, label: "Sesión simulada (demo)" }, { "set-cookie": cookie, "x-trace-id": traceId });
}

export function sessionCookie(token: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
