import { createHash, createHmac } from "node:crypto";
import { prepareBooking } from "@/application/booking/prepare-booking";
import { getAvailableSlots, listWorkshops, requestQuote } from "@/application/booking/quotes-and-slots";
import type { BookingDeps } from "@/application/booking/common";
import type { AppError } from "@/application/errors";
import { evaluateVehicle } from "@/application/evaluate-vehicle";
import { getMaintenancePlan } from "@/application/get-maintenance-plan";
import { getServiceHistory } from "@/application/get-service-history";
import { getVehicleProfile } from "@/application/get-vehicle-profile";
import { applyJourneyEvent, findJourney } from "@/application/journey/journey-store";
import { openHumanCase } from "@/application/open-human-case";
import { recordOdometer } from "@/application/record-odometer";
import { reportSafetySignal } from "@/application/report-safety-signal";
import { isToolAllowed, type AgentToolName, type JourneyState } from "@/domain/journey";
import type { ActorContext } from "@/domain/policies/access-policy";
import { decideProcessingConsent } from "@/domain/policies/consent-policy";
import type { Prisma } from "@/generated/prisma/client";
import { isAgentTool, TOOL_SCHEMAS, type ToolInputs } from "./tools/definitions";

/** Contexto que inyecta el servidor: el modelo nunca lo ve ni lo envía. */
export interface AgentSessionContext {
  sessionId: string;
  traceId: string;
  /** Propietario autenticado de la sesión. */
  owner: ActorContext;
  /** El agente actúa por cuenta del propietario (SYSTEM_AGENT con su customerId). */
  agent: ActorContext;
  vehicleId: string;
  serviceCode: string;
}

export interface GatewayDeps extends BookingDeps {
  /** Secreto para pseudonimizar vehicleId en ToolCall (LOG_HASH_SECRET). */
  hashSecret: string;
}

export type ToolErrorCode =
  | AppError["code"]
  | "UNKNOWN_TOOL"
  | "INVALID_INPUT"
  | "TOOL_NOT_ALLOWED_IN_STATE"
  | "TOOL_CALL_LIMIT";

export interface ToolCallRecord {
  tool: string;
  ok: boolean;
  errorCode: string | null;
  source: "MOCK" | "REAL" | "INTERNAL";
  durationMs: number;
  journeyStateAtCall: JourneyState;
  /** Resumen seguro para la traza visible (sin PII ni tokens). */
  summary: string;
}

type OutcomeDraft =
  | { ok: true; tool: AgentToolName; input: unknown; data: Record<string, unknown>; forModel: Record<string, unknown>; safetyEscalated?: { caseId: string } }
  | { ok: false; tool: string; input: unknown; error: { code: ToolErrorCode; retryable: boolean; userSafeMessage: string; detail?: string; refs?: Record<string, string> } };

export type ToolOutcome = OutcomeDraft & { forModel: Record<string, unknown>; record: ToolCallRecord };

const USER_SAFE: Partial<Record<ToolErrorCode, string>> = {
  UNKNOWN_TOOL: "Esa acción no existe para el asistente.",
  INVALID_INPUT: "Los datos de la solicitud no son válidos.",
  TOOL_NOT_ALLOWED_IN_STATE: "Esa acción no está disponible en este momento del proceso.",
  TOOL_CALL_LIMIT: "Se alcanzó el límite de consultas de este turno.",
  UNAUTHORIZED: "No hay acceso a esa información.",
  CONSENT_REQUIRED: "Falta la autorización para procesar la conversación con el asistente.",
  PLAN_NOT_VERIFIED: "El plan técnico de este vehículo está pendiente de verificación.",
  QUOTE_UNAVAILABLE: "El taller no tiene precio para este servicio; un asesor preparará la cotización.",
  QUOTE_EXPIRED: "La cotización venció; hay que solicitar una nueva.",
  QUOTE_MISMATCH: "La cotización no corresponde a la vigente para este vehículo.",
  NO_SLOTS: "No hay horarios disponibles en ese taller para los próximos días.",
  SLOT_CONFLICT: "Ese horario ya no está disponible.",
  WORKSHOP_UNAVAILABLE: "El sistema del taller no responde en este momento.",
  ACTIVE_BOOKING_EXISTS: "Ya existe una reserva activa para este servicio.",
  SAFETY_ESCALATED: "El proceso está detenido por un posible riesgo de seguridad; lo atiende una persona.",
  ODOMETER_ROLLBACK: "El kilometraje indicado es menor que una lectura verificada.",
  JOURNEY_STATE_INVALID: "Esa acción no corresponde al estado actual del proceso.",
};

const MAX_TOOL_CALLS_PER_TURN = 8;

/**
 * Tool Gateway (AGENT_DESIGN.md §4): catálogo → esquema estricto → contexto del servidor → autorización (en el
 * caso de uso) → estado del journey → idempotencia → ejecución → registro ToolCall → proyección para el modelo.
 * El modelo no accede a Prisma ni a los adaptadores: solo a casos de uso a través de este gateway.
 */
export class ToolGateway {
  private callsThisTurn = 0;
  private consentVerified: boolean | null = null;

  constructor(
    private readonly deps: GatewayDeps,
    private readonly ctx: AgentSessionContext,
  ) {}

  async execute(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const started = Date.now();
    const journey = await findJourney(this.deps.db, { vehicleId: this.ctx.vehicleId, serviceCode: this.ctx.serviceCode });
    const state: JourneyState = journey?.state ?? "ACTIVATED";
    const fail = (code: ToolErrorCode, retryable = false, detail?: string) =>
      this.finish({ ok: false, tool: name, input: rawInput, error: { code, retryable, userSafeMessage: USER_SAFE[code] ?? "No fue posible completar la acción.", detail } }, state, started, "INTERNAL");


    if (++this.callsThisTurn > MAX_TOOL_CALLS_PER_TURN) return fail("TOOL_CALL_LIMIT");
    if (!isAgentTool(name)) return fail("UNKNOWN_TOOL", false, name);
    const parsed = TOOL_SCHEMAS[name].safeParse(rawInput ?? {});
    if (!parsed.success) return fail("INVALID_INPUT", false, parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}:${i.code}`).join(","));
    if (!isToolAllowed(state, name)) return fail("TOOL_NOT_ALLOWED_IN_STATE", false, state);
    if (!(await this.hasProcessingConsent())) return fail("CONSENT_REQUIRED");

    const key = this.idempotencyKey(name, parsed.data);
    const result = await this.run(name, parsed.data as never, key);
    if (!result.ok) {
      const e = result.error;
      return this.finish(
        { ok: false, tool: name, input: parsed.data, error: { code: e.code, retryable: e.retryable ?? false, userSafeMessage: USER_SAFE[e.code] ?? "No fue posible completar la acción.", detail: e.detail, refs: e.refs } },
        state,
        started,
        result.source,
        key,
      );
    }
    return this.finish(
      { ok: true, tool: name, input: parsed.data, data: result.data, forModel: result.forModel, ...(result.safetyCaseId ? { safetyEscalated: { caseId: result.safetyCaseId } } : {}) },
      state,
      started,
      result.source,
      key,
    );
  }

  /** Consentimiento AI_ASSISTANT_PROCESSING del titular (D-12), verificado una vez por gateway (turno). */
  private async hasProcessingConsent(): Promise<boolean> {
    if (this.consentVerified === null) {
      const consents = await this.deps.db.consent.findMany({ where: { customerId: this.ctx.agent.customerId ?? "" }, include: { events: true } });
      this.consentVerified = decideProcessingConsent(consents).allowed;
    }
    return this.consentVerified;
  }

  private idempotencyKey(tool: string, input: unknown): string {
    return createHash("sha256").update(`${this.ctx.traceId}:${tool}:${JSON.stringify(input)}`).digest("hex").slice(0, 32);
  }

  private async run<K extends AgentToolName>(
    tool: K,
    input: ToolInputs[K],
    key: string,
  ): Promise<
    | { ok: true; data: Record<string, unknown>; forModel: Record<string, unknown>; source: ToolCallRecord["source"]; safetyCaseId?: string }
    | { ok: false; error: AppError; source: ToolCallRecord["source"] }
  > {
    const { deps, ctx } = this;
    const base = { actor: ctx.agent, vehicleId: ctx.vehicleId };
    const done = (data: Record<string, unknown>, source: ToolCallRecord["source"] = "INTERNAL", forModel: Record<string, unknown> = data) => ({ ok: true as const, data, forModel, source });
    const failed = (error: AppError, source: ToolCallRecord["source"] = "INTERNAL") => ({ ok: false as const, error, source });

    switch (tool) {
      case "getVehicleProfile": {
        const r = await getVehicleProfile(deps, base);
        if (!r.ok) return failed(r.error);
        // Sin placa (ni enmascarada) para el modelo: no la necesita.
        const { plateMasked: _plate, ...profile } = r.value;
        void _plate;
        return done(profile as unknown as Record<string, unknown>);
      }
      case "getServiceHistory": {
        const r = await getServiceHistory(deps, base);
        return r.ok ? done(r.value as unknown as Record<string, unknown>) : failed(r.error);
      }
      case "getMaintenancePlan": {
        const r = await getMaintenancePlan(deps, base);
        return r.ok ? done(r.value as unknown as Record<string, unknown>) : failed(r.error);
      }
      case "evaluateMaintenance": {
        const r = await evaluateVehicle(deps, { ...base, serviceCode: ctx.serviceCode, traceId: ctx.traceId });
        if (!r.ok) return failed(r.error);
        const res = r.value.result;
        const event = { type: "EVALUATED" as const, evaluationId: r.value.evaluationId, status: res.status, reasons: res.reasons, requiresOdometerConfirmation: res.requiresOdometerConfirmation, cycleKey: r.value.cycleKey };
        // En conversación cada evaluación explícita se registra (idempotente por evaluación): es la base de la
        // recomendación que verá el propietario (a diferencia del job, que omite las redundantes).
        const journey = await findJourney(deps.db, { vehicleId: ctx.vehicleId, serviceCode: ctx.serviceCode });
        let journeyState = journey?.state ?? "ACTIVATED";
        const applied = await applyJourneyEvent(deps.db, { vehicleId: ctx.vehicleId, serviceCode: ctx.serviceCode, event, actor: { actorId: ctx.agent.actorId, role: ctx.agent.role }, traceId: ctx.traceId, idempotencyKey: `agent-evaluated:${r.value.evaluationId}` });
        if (applied.ok) journeyState = applied.value.to;
        return done({
          evaluationId: r.value.evaluationId,
          serviceCode: res.serviceCode,
          status: res.status,
          technical: res.technical,
          communication: res.communication,
          reasons: res.reasons,
          requiresOdometerConfirmation: res.requiresOdometerConfirmation,
          suggestedAction: res.suggestedAction,
          plan: res.plan ? { version: res.plan.version, sourceRef: res.plan.sourceRef } : null,
          syntheticData: res.dataOrigin.containsSyntheticData,
          engineVersion: res.engineVersion,
          journeyState,
        });
      }
      case "recordOdometer": {
        const r = await recordOdometer(deps, { ...base, valueKm: (input as ToolInputs["recordOdometer"]).valueKm, traceId: ctx.traceId, idempotencyKey: key });
        return r.ok ? done(r.value as unknown as Record<string, unknown>) : failed(r.error);
      }
      case "listWorkshops": {
        const r = await listWorkshops(deps, { ...base, serviceCode: ctx.serviceCode });
        return r.ok ? done({ workshops: r.value }) : failed(r.error);
      }
      case "getQuote": {
        const r = await requestQuote(deps, { ...base, serviceCode: ctx.serviceCode, workshopId: (input as ToolInputs["getQuote"]).workshopId, traceId: ctx.traceId, idempotencyKey: key });
        return r.ok ? done(r.value as unknown as Record<string, unknown>, r.value.source) : failed(r.error, "MOCK");
      }
      case "getAvailableSlots": {
        const r = await getAvailableSlots(deps, { ...base, serviceCode: ctx.serviceCode, workshopId: (input as ToolInputs["getAvailableSlots"]).workshopId, traceId: ctx.traceId, idempotencyKey: key });
        return r.ok ? done({ ...r.value, workshopId: (input as ToolInputs["getAvailableSlots"]).workshopId }, r.value.source) : failed(r.error, "MOCK");
      }
      case "prepareBooking": {
        const i = input as ToolInputs["prepareBooking"];
        const r = await prepareBooking(deps, { ...base, serviceCode: ctx.serviceCode, quoteId: i.quoteId, slotRef: i.slotRef, traceId: ctx.traceId, idempotencyKey: key });
        if (!r.ok) return failed(r.error, "MOCK");
        // El token de confirmación nunca llega al modelo, a la transcripción ni a los registros.
        const { confirmationToken: _token, ...forModel } = r.value;
        void _token;
        return done(r.value as unknown as Record<string, unknown>, r.value.summary.source, forModel as unknown as Record<string, unknown>);
      }
      case "createHumanCase": {
        const i = input as ToolInputs["createHumanCase"];
        if (i.reason === "SAFETY_ESCALATION") {
          const r = await reportSafetySignal(deps, { ...base, serviceCode: ctx.serviceCode, source: "AGENT_TOOL", summary: i.summary, traceId: ctx.traceId, idempotencyKey: key });
          if (!r.ok) return failed("code" in r.error && typeof r.error.code === "string" ? ({ code: r.error.code === "TERMINAL_STATE" ? "JOURNEY_STATE_INVALID" : (r.error.code as AppError["code"]) } as AppError) : { code: "JOURNEY_STATE_INVALID" });
          return { ...done({ caseId: r.value.caseId, reason: "SAFETY_ESCALATION", priority: "URGENT", journeyState: r.value.journeyState }), safetyCaseId: r.value.caseId };
        }
        if (i.priority === "URGENT") return failed({ code: "INVALID_INPUT", detail: "URGENT_ONLY_FOR_SAFETY" });
        const r = await openHumanCase(deps, { ...base, serviceCode: ctx.serviceCode, reason: i.reason, priority: i.priority, summary: i.summary, traceId: ctx.traceId, idempotencyKey: key });
        return r.ok ? done({ caseId: r.value.caseId, reason: i.reason, priority: i.priority, slaDueAt: r.value.slaDueAt.toISOString(), assigned: r.value.assigneeId !== null, journeyState: r.value.journeyState }) : failed(r.error);
      }
    }
    return failed({ code: "INVALID_INPUT" });
  }

  private async finish(outcome: OutcomeDraft, state: JourneyState, started: number, source: ToolCallRecord["source"], key?: string): Promise<ToolOutcome> {
    const durationMs = Date.now() - started;
    const record: ToolCallRecord = {
      tool: outcome.tool,
      ok: outcome.ok,
      errorCode: outcome.ok ? null : outcome.error.code,
      source,
      durationMs,
      journeyStateAtCall: state,
      summary: summarize(outcome),
    };
    const forModel = outcome.ok
      ? withLocalTimes(outcome.forModel)
      : { error: outcome.error.code, message: outcome.error.userSafeMessage, ...(outcome.error.refs ? { refs: outcome.error.refs } : {}) };

    await this.deps.db.toolCall.create({
      data: {
        sessionId: this.ctx.sessionId,
        traceId: this.ctx.traceId,
        toolName: outcome.tool.slice(0, 80),
        actorId: this.ctx.agent.actorId,
        actorRole: this.ctx.agent.role,
        vehicleIdHash: createHmac("sha256", this.deps.hashSecret).update(this.ctx.vehicleId).digest("hex").slice(0, 32),
        inputRedacted: redact(outcome.input) as Prisma.InputJsonValue,
        outputSummary: { summary: record.summary } as Prisma.InputJsonValue,
        ok: outcome.ok,
        errorCode: record.errorCode,
        stateAtCall: state,
        source,
        idempotencyKey: key ?? null,
        durationMs,
      },
    });
    return { ...outcome, forModel, record };
  }
}

/** Entrada para el registro: solo campos esperados y acotados (el texto libre se trunca). */
function redact(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { kind: typeof input };
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .slice(0, 6)
      .map(([k, v]) => [k.slice(0, 40), typeof v === "string" ? (k === "summary" ? `[texto ${v.length} caracteres]` : v.slice(0, 80)) : typeof v === "number" || typeof v === "boolean" ? v : `[${typeof v}]`]),
  );
}

function summarize(outcome: OutcomeDraft): string {
  if (!outcome.ok) return `error=${outcome.error.code}`;
  const d = outcome.data as Record<string, unknown>;
  switch (outcome.tool) {
    case "evaluateMaintenance":
      return `status=${d.status}; plan=${(d.plan as { version?: string } | null)?.version ?? "ninguno"}; motor=${d.engineVersion}`;
    case "getQuote":
      return `cotización ${d.quoteId}; total=${d.totalCop} COP; fuente=${d.source}`;
    case "getAvailableSlots":
      return `${(d.slots as unknown[]).length} horarios; fuente=${d.source}`;
    case "prepareBooking":
      return `intención ${d.intentId}; expira=${(d.expiresAt as Date).toISOString?.() ?? d.expiresAt}`;
    case "createHumanCase":
      return `caso ${d.caseId}; motivo=${d.reason}; prioridad=${d.priority}`;
    case "recordOdometer":
      return `lectura ${d.valueKm} km; ${d.provenance}`;
    case "listWorkshops":
      return `${(d.workshops as unknown[]).length} talleres`;
    case "getMaintenancePlan":
      return `plan ${d.version}; ${(d.rules as unknown[]).length} reglas`;
    default:
      return "ok";
  }
}

const LOCAL_FMT = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "full", timeStyle: "short" });
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Para el modelo: junto a cada fecha-hora (Date o ISO UTC) agrega `<campo>Local` en hora de Colombia, ya formateada.
 * Evita que el asistente muestre horas UTC al propietario (observado con Claude real, Fase 8A). El valor ISO se
 * conserva porque identifica cupos y lo usa la guardia de salida.
 */
export function withLocalTimes(value: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v.toISOString();
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(v)) {
      out[k] = walk(raw);
      const iso = raw instanceof Date ? raw.toISOString() : typeof raw === "string" && ISO_DATETIME.test(raw) ? raw : null;
      if (iso && !Number.isNaN(Date.parse(iso))) out[`${k}Local`] = `${LOCAL_FMT.format(new Date(iso))} (hora de Colombia)`;
    }
    return out;
  };
  return walk(value) as Record<string, unknown>;
}
