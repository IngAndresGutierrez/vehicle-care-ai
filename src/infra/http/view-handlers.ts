import { z } from "zod";
import { DEMO_SCENARIOS, simulateSlotTaken, startDemoScenario, type DemoScenarioKey } from "@/application/demo/demo-runs";
import { resolveHumanCase } from "@/application/resolve-human-case";
import { getCasesInbox, getMe, getTraceView, getVehicleOverview } from "@/application/views/read-models";
import type { Container } from "../container";
import { newTraceId } from "../ids";
import { DEMO_RUNS_COOKIE, readCookie, signDemoRuns, signSession, verifyDemoRuns } from "../session";
import { authenticate, demoRunsCookie, json, problem, readJson, sessionCookie } from "./handlers";

const SERVICE = z.enum(["ENGINE_OIL_FILTER", "TIMING_BELT"]);
const ID = z.string().min(1).max(80);

const statusFor = (code: string) => (code === "UNAUTHORIZED" ? 403 : code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : 409);

/** GET /api/me — identidad de la sesión y vehículos visibles. */
export async function handleMe(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Sin sesión.", traceId);
  return json(200, await getMe(c, actor), { "x-trace-id": traceId });
}

/** GET /api/vehicles/:id/overview?serviceCode= — portal del propietario (o del asesor con acceso). */
export async function handleVehicleOverview(request: Request, c: Container, vehicleId: string): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Sin sesión.", traceId);
  const service = SERVICE.safeParse(new URL(request.url).searchParams.get("serviceCode") ?? "ENGINE_OIL_FILTER");
  if (!ID.safeParse(vehicleId).success || !service.success) return problem(400, "INVALID_REQUEST", "Parámetros inválidos.", traceId);
  const r = await getVehicleOverview(c, { actor, vehicleId, serviceCode: service.data });
  return r.ok ? json(200, r.value, { "x-trace-id": traceId }) : problem(statusFor(r.error.code), r.error.code, "No tienes acceso a ese vehículo.", traceId);
}

/**
 * GET /api/vehicles/:id/trace?serviceCode= — panel de trazabilidad. Compliance debe enviar la justificación en la
 * cabecera `x-audit-justification` (queda en AuditLog, ADR-016).
 */
export async function handleVehicleTrace(request: Request, c: Container, vehicleId: string): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Sin sesión.", traceId);
  const service = SERVICE.safeParse(new URL(request.url).searchParams.get("serviceCode") ?? "ENGINE_OIL_FILTER");
  if (!ID.safeParse(vehicleId).success || !service.success) return problem(400, "INVALID_REQUEST", "Parámetros inválidos.", traceId);
  const justification = request.headers.get("x-audit-justification")?.slice(0, 500) ?? undefined;
  const r = await getTraceView(c, { actor, vehicleId, serviceCode: service.data, justification });
  return r.ok ? json(200, r.value, { "x-trace-id": traceId }) : problem(statusFor(r.error.code), r.error.code, r.error.detail === "JUSTIFICATION_REQUIRED" ? "Indica el motivo de la consulta de auditoría." : "No tienes acceso a esas trazas.", traceId);
}

/** GET /api/cases — bandeja de atención humana (asesor o compliance). */
export async function handleCases(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Sin sesión.", traceId);
  const r = await getCasesInbox(c, actor);
  return r.ok ? json(200, { cases: r.value }, { "x-trace-id": traceId }) : problem(403, r.error.code, "La bandeja es solo para el equipo de atención.", traceId);
}

const ResolveBody = z.object({ outcome: z.enum(["CLEARED_FOR_SERVICE", "REEVALUATE", "CLOSE"]), resolution: z.string().trim().min(5).max(1000) }).strict();

/** POST /api/cases/:id/resolve — acción humana autorizada (solo el responsable asignado). */
export async function handleResolveCase(request: Request, c: Container, caseId: string): Promise<Response> {
  const traceId = newTraceId();
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Sin sesión.", traceId);
  const body = await readJson(request, traceId);
  if (!body.ok) return body.response;
  const parsed = ResolveBody.safeParse(body.body);
  if (!parsed.success || !ID.safeParse(caseId).success) return problem(400, "INVALID_REQUEST", "Indica la decisión y una nota de al menos 5 caracteres.", traceId);
  const r = await resolveHumanCase(c, { actor, caseId, outcome: parsed.data.outcome, resolution: parsed.data.resolution, traceId, idempotencyKey: `${caseId}:${parsed.data.outcome}` });
  if (!r.ok) return problem(statusFor(r.error.code), r.error.code, "No es posible resolver este caso con esa decisión.", traceId);
  return json(200, r.value, { "x-trace-id": traceId });
}

// ───────────────────────────── Demo (solo DEMO_MODE) ─────────────────────────────

/** GET /api/demo/config — modo demo, escenarios y LLM en uso (para rotular la simulación). */
export async function handleDemoConfig(_request: Request, c: Container): Promise<Response> {
  return json(200, {
    demoMode: c.demoMode,
    llm: c.llm.info,
    scenarios: c.demoMode ? Object.entries(DEMO_SCENARIOS).map(([key, s]) => ({ key, title: s.title, description: s.description, serviceCode: s.serviceCode, suggestedMessages: s.suggestedMessages })) : [],
  });
}

const ScenarioBody = z.object({ scenario: z.enum(["A", "B", "C", "D"]) }).strict();

/**
 * IP del cliente para el limitador. Se toma la entrada MÁS A LA DERECHA de `x-forwarded-for`: la añade el proxy de
 * confianza (Railway la agrega al final; Vercel reemplaza la cabecera). La primera la controla el cliente y permitiría
 * saltarse el límite enviando una IP falsa (comprobado en Railway).
 */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || request.headers.get("x-real-ip") || "local";
}

/**
 * POST /api/demo/scenarios — inicia una corrida AISLADA del escenario con un propietario sintético nuevo y entra
 * con su sesión. No borra ni reinicia datos compartidos. Solo con DEMO_MODE=true y con límite por IP.
 */
export async function handleDemoStart(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  if (!c.demoMode) return problem(404, "NOT_FOUND", "No disponible.", traceId);
  const limit = c.demoLimiter.check(`demo:${clientIp(request)}`, c.clock.now());
  if (!limit.allowed) return problem(429, "RATE_LIMITED", "Demasiadas corridas de demo; espera unos minutos.", traceId, { "retry-after": String(limit.retryAfterSeconds) });
  const body = await readJson(request, traceId);
  if (!body.ok) return body.response;
  const parsed = ScenarioBody.safeParse(body.body);
  if (!parsed.success) return problem(400, "INVALID_REQUEST", "Escenario inválido.", traceId);
  // Tope global en la base: protege la demo pública aunque el limitador por IP (en memoria) no sea compartido.
  const now = c.clock.now();
  const today = await c.db.auditLog.count({ where: { action: "DEMO_RUN_STARTED", occurredAt: { gte: new Date(now.getTime() - 86_400_000) } } });
  if (today >= c.demoRunsPerDay) return problem(429, "DEMO_DAILY_LIMIT", "La demo alcanzó su límite diario de corridas. Intenta mañana.", traceId);
  const run = await startDemoScenario(c, { scenario: parsed.data.scenario as DemoScenarioKey, traceId });
  if (!run.ok) return problem(409, run.error.code, "No fue posible preparar el escenario.", traceId);
  const ttl = 8 * 3600;
  const exp = Math.floor(now.getTime() / 1000) + ttl;
  const token = signSession({ actorId: run.value.ownerActorId, exp }, c.sessionSecret);
  const previous = verifyDemoRuns(readCookie(request.headers.get("cookie"), DEMO_RUNS_COOKIE), c.sessionSecret, now);
  const runs = signDemoRuns([run.value.runId, ...previous.filter((r) => r !== run.value.runId)], exp, c.sessionSecret);
  const res = json(200, { ...run.value, label: "Datos sintéticos de demostración" }, { "x-trace-id": traceId });
  res.headers.append("set-cookie", sessionCookie(token, ttl));
  res.headers.append("set-cookie", demoRunsCookie(runs, ttl));
  return res;
}

/** POST /api/demo/slot-taken — escenario D: otro cliente toma el cupo de MI intención pendiente (solo DEMO_MODE). */
export async function handleDemoSlotTaken(request: Request, c: Container): Promise<Response> {
  const traceId = newTraceId();
  if (!c.demoMode) return problem(404, "NOT_FOUND", "No disponible.", traceId);
  const actor = await authenticate(request, c);
  if (!actor) return problem(401, "UNAUTHENTICATED", "Sin sesión.", traceId);
  const r = await simulateSlotTaken(c, { actor, traceId });
  return r.ok ? json(200, { ...r.value, label: "Simulación de demo" }, { "x-trace-id": traceId }) : problem(statusFor(r.error.code), r.error.code, "No hay una reserva pendiente de confirmar.", traceId);
}
