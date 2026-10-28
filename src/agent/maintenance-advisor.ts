import { applyJourneyEvent, ensureJourney, findJourney } from "@/application/journey/journey-store";
import { runInTransaction } from "@/application/transaction";
import { reportSafetySignal } from "@/application/report-safety-signal";
import { authorizeVehicleAccess } from "@/application/vehicle-access";
import { allowedTools, type JourneyState } from "@/domain/journey";
import type { ActorContext } from "@/domain/policies/access-policy";
import { decideProcessingConsent } from "@/domain/policies/consent-policy";
import { toLocalDate } from "@/domain/shared/local-date";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Prisma } from "@/generated/prisma/client";
import { buildCards, redactCards, type Card } from "./cards";
import { ToolGateway, type AgentSessionContext, type GatewayDeps, type ToolCallRecord, type ToolOutcome } from "./gateway";
import { CONTEXT_HEADER } from "./llm/scripted-llm";
import type { LlmBlock, LlmMessage, LlmPort } from "./llm/types";
import { parseMemory, pruneMemory, type AdvisorMemory } from "./memory";
import { checkOutput, GUARD_FALLBACK_TEXT, numbersIn, type GuardFacts, type GuardViolation } from "./output-guard";
import { ADVISOR_PROMPT_VERSION, ADVISOR_SYSTEM_PROMPT } from "./prompts/advisor-v1";
import { detectInjection } from "./safety/injection";
import { classifySafety, safetyTemplate } from "./safety/lexicon";
import { LLM_TOOL_DEFINITIONS } from "./tools/definitions";

export interface AdvisorLimits {
  maxIterations: number;
  maxOutputTokensPerCall: number;
  maxOutputTokensPerTurn: number;
  turnTimeoutMs: number;
  maxMessageChars: number;
  maxTurnsPerSession: number;
}

export const DEFAULT_LIMITS: AdvisorLimits = {
  maxIterations: 6,
  maxOutputTokensPerCall: 4_096,
  maxOutputTokensPerTurn: 16_000,
  turnTimeoutMs: 45_000,
  maxMessageChars: 2_000,
  maxTurnsPerSession: 40,
};

export interface AdvisorDeps extends GatewayDeps {
  llm: LlmPort;
  limits?: Partial<AdvisorLimits>;
}

export interface TurnInput {
  owner: ActorContext;
  vehicleId: string;
  serviceCode?: string;
  sessionId?: string;
  message: string;
  traceId: string;
}

export interface TurnResult {
  traceId: string;
  sessionId: string;
  assistant: { text: string; kind: "ASSISTANT" | "SYSTEM_NOTICE"; simulated: boolean; model: string };
  cards: Card[];
  journey: { state: JourneyState; allowedTools: readonly string[] };
  trace: {
    toolCalls: ToolCallRecord[];
    llm: { provider: string; model: string; iterations: number; inputTokens: number; outputTokens: number; stopReason: string | null };
    safety: { triggered: boolean; categories: string[] };
    guard: { blocked: boolean; violations: GuardViolation[] };
    flags: string[];
  };
  errors: Array<{ code: string; message: string; retryable: boolean }>;
}

export type TurnError = { status: 400 | 403 | 404 | 409; code: string; message: string };

const SUPPORTED_SERVICES = new Set(["ENGINE_OIL_FILTER", "TIMING_BELT"]);
const OPENABLE: ReadonlySet<JourneyState> = new Set(["ACTIVATED", "NEED_DETECTED", "CONTACT_SUPPRESSED", "MONITORING"]);
const ACTIONABLE = new Set(["UPCOMING", "DUE", "OVERDUE"]);
const MEMORY_TTL_MS = 30 * 60_000;

/**
 * MaintenanceAdvisor (AGENT_DESIGN.md §2). El LLM conversa y orquesta; las decisiones técnicas las toma el motor,
 * las comerciales los casos de uso, y los controles los aplica el gateway en código.
 */
export class MaintenanceAdvisor {
  private readonly limits: AdvisorLimits;

  constructor(private readonly deps: AdvisorDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  async handleTurn(input: TurnInput): Promise<Result<TurnResult, TurnError>> {
    const { db, clock, llm } = this.deps;
    const now = clock.now();
    const serviceCode = input.serviceCode ?? "ENGINE_OIL_FILTER";
    const message = input.message.trim();

    if (input.owner.role !== "OWNER" || !input.owner.customerId) return err({ status: 403, code: "OWNER_SESSION_REQUIRED", message: "El asistente atiende solo a propietarios autenticados." });
    if (!message || message.length > this.limits.maxMessageChars) return err({ status: 400, code: "INVALID_MESSAGE", message: `El mensaje debe tener entre 1 y ${this.limits.maxMessageChars} caracteres.` });
    if (!SUPPORTED_SERVICES.has(serviceCode)) return err({ status: 400, code: "UNSUPPORTED_SERVICE", message: "Servicio no soportado." });

    const access = await authorizeVehicleAccess(db, input.owner, input.vehicleId, "READ_VEHICLE", now);
    if (!access.ok) return err({ status: 403, code: "UNAUTHORIZED", message: "No tienes acceso a ese vehículo." });

    // ── Sesión: siempre del mismo propietario, vehículo y servicio ──
    const session = input.sessionId
      ? await db.conversationSession.findUnique({ where: { id: input.sessionId } })
      : await db.conversationSession.create({
          data: { vehicleId: input.vehicleId, actorId: input.owner.actorId, customerId: input.owner.customerId, serviceCode, memory: {}, promptVersion: ADVISOR_PROMPT_VERSION, model: llm.info.model },
        });
    if (!session) return err({ status: 404, code: "SESSION_NOT_FOUND", message: "La sesión no existe." });
    if (session.actorId !== input.owner.actorId || session.vehicleId !== input.vehicleId || session.serviceCode !== serviceCode) {
      return err({ status: 403, code: "SESSION_MISMATCH", message: "La sesión no corresponde a este propietario, vehículo o servicio." });
    }
    if (session.status !== "ACTIVE" || session.turnCount >= this.limits.maxTurnsPerSession) return err({ status: 409, code: "SESSION_CLOSED", message: "La sesión terminó; inicia una nueva." });

    const ctx: AgentSessionContext = {
      sessionId: session.id,
      traceId: input.traceId,
      owner: input.owner,
      agent: { actorId: "agent:maintenance-advisor", role: "SYSTEM_AGENT", customerId: input.owner.customerId, workshopId: null },
      vehicleId: input.vehicleId,
      serviceCode,
    };
    const result: TurnResult = {
      traceId: input.traceId,
      sessionId: session.id,
      assistant: { text: "", kind: "ASSISTANT", simulated: llm.info.simulated, model: llm.info.model },
      cards: [],
      journey: { state: "ACTIVATED", allowedTools: [] },
      trace: { toolCalls: [], llm: { provider: llm.info.provider, model: llm.info.model, iterations: 0, inputTokens: 0, outputTokens: 0, stopReason: null }, safety: { triggered: false, categories: [] }, guard: { blocked: false, violations: [] }, flags: [] },
      errors: [],
    };

    // ── Consentimiento para tratar la conversación con IA (D-12): sin él no se procesa ni se guarda el mensaje ──
    const consents = await db.consent.findMany({ where: { customerId: input.owner.customerId }, include: { events: true } });
    if (!decideProcessingConsent(consents).allowed) {
      result.assistant = { ...result.assistant, kind: "SYSTEM_NOTICE", text: "Para usar el asistente necesitamos tu autorización para tratar la conversación con inteligencia artificial. Puedes otorgarla en tus preferencias; mientras tanto, un asesor puede atenderte." };
      result.errors.push({ code: "CONSENT_REQUIRED", message: "Falta el consentimiento AI_ASSISTANT_PROCESSING.", retryable: false });
      await this.fillJourney(result, ctx);
      return ok(result);
    }

    // ── Apertura del journey por el propietario ──
    const journey = await runInTransaction(db, async (tx) => ok(await ensureJourney(tx, ctx)));
    if (journey.ok && OPENABLE.has(journey.value.state)) {
      await applyJourneyEvent(db, { vehicleId: ctx.vehicleId, serviceCode, event: { type: "OWNER_OPENED" }, actor: { actorId: input.owner.actorId, role: "OWNER" }, traceId: input.traceId, idempotencyKey: `owner-opened:${session.id}:${session.turnCount}` });
    }

    const flags = detectInjection(message);
    result.trace.flags = flags;
    await db.conversationMessage.create({ data: { sessionId: session.id, role: "USER", content: message, traceId: input.traceId, flagged: flags, createdAt: now } });

    const memory = pruneMemory(parseMemory(session.memory), now);
    const transcript = (session.transcript as unknown as LlmMessage[]) ?? [];

    // ── Seguridad ANTES del LLM (EX-02) ──
    const safety = classifySafety(message);
    if (safety.hit) return this.safetyPath(result, ctx, session, memory, transcript, message, safety.categories, safety.lexiconVersion);

    // ── Bucle del agente ──
    const gateway = new ToolGateway(this.deps, ctx);
    const journeyNow = await findJourney(db, ctx);
    const turnMessages: LlmMessage[] = [
      { role: "user", content: [{ type: "text", text: message }] },
      { role: "system", content: [{ type: "text", text: this.contextBlock(journeyNow?.state ?? "ACTIVATED", serviceCode, memory) }] },
    ];
    const outcomes: ToolOutcome[] = [];
    let finalText: string | null = null;
    let llmFailed = false;
    let safetyCaseId: string | null = null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.limits.turnTimeoutMs);

    try {
      for (let i = 0; i < this.limits.maxIterations; i++) {
        const response = await llm.complete({ system: ADVISOR_SYSTEM_PROMPT, messages: [...transcript, ...turnMessages], tools: LLM_TOOL_DEFINITIONS, maxOutputTokens: this.limits.maxOutputTokensPerCall, signal: abort.signal });
        result.trace.llm.iterations++;
        result.trace.llm.inputTokens += response.usage.inputTokens;
        result.trace.llm.outputTokens += response.usage.outputTokens;
        result.trace.llm.stopReason = response.stopReason;
        turnMessages.push({ role: "assistant", content: response.content });

        if (response.stopReason !== "tool_use") {
          finalText = this.finalTextFor(response.stopReason, response.content, result);
          break;
        }
        const toolResults: LlmBlock[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          const outcome = await gateway.execute(block.name, block.input);
          outcomes.push(outcome);
          result.trace.toolCalls.push(outcome.record);
          if (!outcome.ok && outcome.error.retryable) result.errors.push({ code: outcome.error.code, message: outcome.error.userSafeMessage, retryable: true });
          if (outcome.ok && outcome.safetyEscalated) safetyCaseId = outcome.safetyEscalated.caseId;
          toolResults.push({ type: "tool_result", toolUseId: block.id, content: JSON.stringify(outcome.forModel), isError: !outcome.ok });
        }
        // Todo tool_use recibe su tool_result, también al cortar el bucle: la transcripción queda válida.
        turnMessages.push({ role: "user", content: toolResults });
        if (safetyCaseId) break;
        if (result.trace.llm.outputTokens >= this.limits.maxOutputTokensPerTurn) {
          result.errors.push({ code: "TOKEN_BUDGET_EXCEEDED", message: "Se alcanzó el límite de consumo del turno.", retryable: true });
          break;
        }
      }
    } catch (error) {
      llmFailed = true;
      result.errors.push({ code: abort.signal.aborted ? "LLM_TIMEOUT" : "LLM_UNAVAILABLE", message: "El asistente no está disponible en este momento.", retryable: true });
      void error;
    } finally {
      clearTimeout(timer);
    }

    if (safetyCaseId) {
      result.cards = [{ type: "SAFETY", caseId: safetyCaseId, categories: ["AGENT_TOOL"], lexiconVersion: "n/a" }];
      result.trace.safety = { triggered: true, categories: ["AGENT_TOOL"] };
      result.assistant = { ...result.assistant, kind: "SYSTEM_NOTICE", text: safetyTemplate(safetyCaseId) };
      turnMessages.push({ role: "assistant", content: [{ type: "text", text: result.assistant.text }] });
      return this.persist(result, ctx, session, this.applyOutcomes(memory, outcomes, now), [...transcript, ...turnMessages], false);
    }

    if (llmFailed) {
      result.assistant.text = "El asistente no está disponible en este momento. Puedes intentarlo de nuevo o pedir que un asesor te contacte.";
      // La transcripción no incluye este turno: un mensaje de sistema sin respuesta la dejaría inválida.
      return this.persist(result, ctx, session, memory, transcript, false);
    }
    if (finalText === null) {
      finalText = "Necesito más tiempo para completar esta solicitud. ¿Puedes repetirla de forma más concreta o prefieres hablar con un asesor?";
      result.errors.push({ code: "ITERATION_LIMIT", message: "Se alcanzó el límite de pasos del turno.", retryable: true });
    }

    // ── Validación de salida contra resultados estructurados ──
    const updated = this.applyOutcomes(memory, outcomes, now);
    const facts = await this.guardFacts(ctx, updated, outcomes, message);
    const guard = checkOutput(finalText, facts);
    if (!guard.ok) {
      result.trace.guard = { blocked: true, violations: guard.violations };
      result.trace.flags.push("OUTPUT_BLOCKED");
      updated.previousResponseBlocked = true;
      finalText = GUARD_FALLBACK_TEXT;
    } else {
      updated.previousResponseBlocked = false;
    }
    result.assistant.text = finalText;
    result.cards = buildCards(outcomes);

    // La recomendación se considera presentada cuando su tarjeta llega al propietario.
    const evaluation = result.cards.find((c) => c.type === "EVALUATION");
    const current = await findJourney(db, ctx);
    if (evaluation && evaluation.type === "EVALUATION" && ACTIONABLE.has(evaluation.status) && current?.state === "CONVERSATION_OPEN" && current.context.lastEvaluation?.evaluationId === evaluation.evaluationId) {
      await applyJourneyEvent(db, { vehicleId: ctx.vehicleId, serviceCode, event: { type: "RECOMMENDATION_SHOWN", evaluationId: evaluation.evaluationId }, actor: { actorId: ctx.agent.actorId, role: "SYSTEM_AGENT" }, traceId: input.traceId, idempotencyKey: `reco:${evaluation.evaluationId}` });
    }

    return this.persist(result, ctx, session, updated, [...transcript, ...turnMessages], !guard.ok);
  }

  private async safetyPath(
    result: TurnResult,
    ctx: AgentSessionContext,
    session: { id: string; turnCount: number },
    memory: AdvisorMemory,
    transcript: LlmMessage[],
    message: string,
    categories: string[],
    lexiconVersion: string,
  ): Promise<Result<TurnResult, TurnError>> {
    const journey = await findJourney(this.deps.db, ctx);
    let caseId: string | null = journey?.state === "SAFETY_ESCALATED" ? journey.context.openCaseId : null;
    if (journey?.state !== "SAFETY_ESCALATED") {
      const signal = await reportSafetySignal(this.deps, {
        actor: ctx.owner,
        vehicleId: ctx.vehicleId,
        serviceCode: ctx.serviceCode,
        source: "SAFETY_LEXICON",
        summary: `Síntomas (${categories.join(", ")}): ${message.slice(0, 300)}`,
        traceId: ctx.traceId,
        idempotencyKey: `${ctx.traceId}:safety`,
      });
      if (signal.ok) caseId = signal.value.caseId;
      else result.errors.push({ code: "SAFETY_CASE_NOT_CREATED", message: "No se pudo registrar el caso; llama a la línea de asistencia.", retryable: true });
    }
    result.trace.safety = { triggered: true, categories };
    result.assistant = { ...result.assistant, kind: "SYSTEM_NOTICE", text: safetyTemplate(caseId) };
    result.cards = [{ type: "SAFETY", caseId, categories, lexiconVersion }];
    // Sin LLM: la respuesta es la plantilla aprobada. Queda en la transcripción para dar continuidad.
    const next: LlmMessage[] = [
      ...transcript,
      { role: "user", content: [{ type: "text", text: message }] },
      { role: "system", content: [{ type: "text", text: `${CONTEXT_HEADER}\n${JSON.stringify({ journeyState: "SAFETY_ESCALATED", note: "Respuesta de seguridad enviada por el servidor con una plantilla aprobada." })}` }] },
      { role: "assistant", content: [{ type: "text", text: result.assistant.text }] },
    ];
    return this.persist(result, ctx, session, memory, next, false);
  }

  private finalTextFor(stop: string, content: LlmBlock[], result: TurnResult): string {
    if (stop === "refusal") {
      result.trace.flags.push("REFUSAL");
      return "No puedo ayudarte con esa solicitud por este canal. Si quieres, te paso con un asesor.";
    }
    if (stop === "max_tokens" || stop === "other") {
      result.errors.push({ code: "INCOMPLETE_RESPONSE", message: "La respuesta quedó incompleta.", retryable: true });
      return "No pude completar la respuesta. ¿Puedes repetir tu pregunta?";
    }
    return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim() || "¿En qué más puedo ayudarte?";
  }

  private contextBlock(state: JourneyState, serviceCode: string, memory: AdvisorMemory): string {
    return `${CONTEXT_HEADER}\n${JSON.stringify({
      journeyState: state,
      allowedTools: allowedTools(state),
      serviceCode,
      memory,
      previousResponseBlocked: memory.previousResponseBlocked,
      note: "Taller, CRM y datos del vehículo son simulados (demostración).",
    })}`;
  }

  /** Actualiza la memoria estructurada con los resultados válidos del turno. */
  private applyOutcomes(memory: AdvisorMemory, outcomes: readonly ToolOutcome[], now: Date): AdvisorMemory {
    const m: AdvisorMemory = structuredClone(memory);
    const ttl = new Date(now.getTime() + MEMORY_TTL_MS).toISOString();
    for (const o of outcomes) {
      if (!o.ok) {
        if (o.tool === "getQuote" && (o.error.code === "QUOTE_EXPIRED" || o.error.code === "QUOTE_UNAVAILABLE")) m.activeQuote = null;
        continue;
      }
      const d = o.data as Record<string, never>;
      switch (o.tool) {
        case "evaluateMaintenance": {
          const t = d.technical as unknown as { dueBy: { km: number | null; date: string | null } | null; remaining: { km: number | null; days: number | null } | null };
          const plan = d.plan as unknown as { version: string; sourceRef: string } | null;
          m.lastEvaluation = { evaluationId: d.evaluationId, status: d.status, suggestedAction: d.suggestedAction, dueByKm: t.dueBy?.km ?? null, dueByDate: t.dueBy?.date ?? null, remainingKm: t.remaining?.km ?? null, remainingDays: t.remaining?.days ?? null, planVersion: plan?.version ?? null, sourceRef: plan?.sourceRef ?? null, synthetic: d.syntheticData, expiresAt: ttl };
          break;
        }
        case "getMaintenancePlan":
          m.plan = { version: d.version, intervals: (d.rules as unknown as Array<{ serviceCode: string; intervalKm: number | null; intervalMonths: number | null }>).map(({ serviceCode, intervalKm, intervalMonths }) => ({ serviceCode, intervalKm, intervalMonths })), expiresAt: ttl };
          break;
        case "recordOdometer":
          m.knownKm = [...new Set([...m.knownKm, d.valueKm as number])].slice(-10);
          break;
        case "listWorkshops":
          m.workshops = (d.workshops as unknown as Array<{ workshopId: string; name: string }>).map(({ workshopId, name }) => ({ workshopId, name }));
          break;
        case "getQuote":
          m.activeQuote = { quoteId: d.quoteId, workshopId: d.workshopId, subtotalCop: d.subtotalCop, taxCop: d.taxCop, totalCop: d.totalCop, validUntil: new Date(d.validUntil).toISOString(), source: d.source };
          if (!m.workshops.some((w) => w.workshopId === (d.workshopId as string))) m.workshops.push({ workshopId: d.workshopId, name: d.workshopId });
          break;
        case "getAvailableSlots":
          m.offeredSlots = (d.slots as unknown as Array<{ slotRef: string; startsAt: Date }>).map((s) => ({ slotRef: s.slotRef, startsAt: new Date(s.startsAt).toISOString(), workshopId: d.workshopId }));
          break;
        case "prepareBooking":
          m.pendingIntent = { intentId: d.intentId, expiresAt: new Date(d.expiresAt).toISOString() };
          break;
        case "createHumanCase":
          m.openCaseRefs = [...new Set([...m.openCaseRefs, d.caseId as string])];
          break;
      }
    }
    return m;
  }

  /** Hechos verificables para el validador de salida: memoria vigente + resultados del turno + reserva real. */
  private async guardFacts(ctx: AgentSessionContext, memory: AdvisorMemory, outcomes: readonly ToolOutcome[], message: string): Promise<GuardFacts> {
    const amounts = new Set<number>();
    const kilometers = new Set<number>(memory.knownKm);
    const periods = new Set<number>([7]);
    const dates = new Set<string>();
    const addDate = (v: unknown) => v && dates.add(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : toLocalDate(new Date(v as string)));
    const addKm = (v: unknown) => typeof v === "number" && kilometers.add(Math.abs(v));

    if (memory.activeQuote) {
      [memory.activeQuote.subtotalCop, memory.activeQuote.taxCop, memory.activeQuote.totalCop].forEach((n) => amounts.add(n));
      addDate(memory.activeQuote.validUntil);
    }
    if (memory.lastEvaluation) {
      addKm(memory.lastEvaluation.dueByKm);
      addKm(memory.lastEvaluation.remainingKm);
      addDate(memory.lastEvaluation.dueByDate);
      if (memory.lastEvaluation.remainingDays != null) periods.add(Math.abs(memory.lastEvaluation.remainingDays));
    }
    for (const i of memory.plan?.intervals ?? []) {
      addKm(i.intervalKm);
      if (i.intervalMonths != null) periods.add(i.intervalMonths);
    }
    memory.offeredSlots.forEach((s) => addDate(s.startsAt));
    if (memory.pendingIntent) addDate(memory.pendingIntent.expiresAt);

    for (const o of outcomes) {
      if (!o.ok) continue;
      const d = o.data as Record<string, unknown>;
      if (o.tool === "getVehicleProfile" && d.odometer) {
        const od = d.odometer as { valueKm: number; observedAt: string };
        addKm(od.valueKm);
        addDate(od.observedAt);
      }
      if (o.tool === "getServiceHistory") {
        for (const r of (d.serviceRecords as Array<{ odometerKm: number; performedOn: string }>) ?? []) {
          addKm(r.odometerKm);
          addDate(r.performedOn);
        }
        for (const r of (d.odometerReadings as Array<{ valueKm: number; observedAt: string }>) ?? []) {
          addKm(r.valueKm);
          addDate(r.observedAt);
        }
      }
      if (o.tool === "prepareBooking") {
        const s = d.summary as { startsAt: Date; totalCop: number; taxCop: number };
        addDate(s.startsAt);
        amounts.add(s.totalCop);
        amounts.add(s.taxCop);
      }
    }

    const journey = await findJourney(this.deps.db, ctx);
    const booking = journey?.context.activeBookingId ? await this.deps.db.booking.findUnique({ where: { id: journey.context.activeBookingId } }) : null;
    const confirmed = booking?.status === "CONFIRMED" && booking.externalBookingRef ? booking.externalBookingRef : null;
    return {
      amounts,
      kilometers,
      periods,
      dates,
      folios: new Set(confirmed ? [confirmed] : []),
      bookingConfirmed: confirmed !== null,
      evaluationUnknown: memory.lastEvaluation?.status === "UNKNOWN",
      userNumbers: numbersIn(message),
    };
  }

  private async fillJourney(result: TurnResult, ctx: AgentSessionContext): Promise<void> {
    const journey = await findJourney(this.deps.db, ctx);
    const state = journey?.state ?? "ACTIVATED";
    result.journey = { state, allowedTools: allowedTools(state) };
  }

  /** Persistencia del turno con bloqueo optimista (turnCount) y transcripción solo de añadido. */
  private async persist(
    result: TurnResult,
    ctx: AgentSessionContext,
    session: { id: string; turnCount: number },
    memory: AdvisorMemory,
    transcript: LlmMessage[],
    blocked: boolean,
  ): Promise<Result<TurnResult, TurnError>> {
    const now = this.deps.clock.now();
    const updated = await this.deps.db.conversationSession.updateMany({
      where: { id: session.id, turnCount: session.turnCount },
      data: { memory: memory as unknown as Prisma.InputJsonValue, transcript: transcript as unknown as Prisma.InputJsonValue, turnCount: session.turnCount + 1 },
    });
    if (updated.count !== 1) return err({ status: 409, code: "CONCURRENT_TURN", message: "Hay otro mensaje en proceso en esta sesión; inténtalo de nuevo." });
    await this.deps.db.conversationMessage.create({
      data: {
        sessionId: session.id,
        role: result.assistant.kind,
        content: result.assistant.text,
        cards: redactCards(result.cards) as unknown as Prisma.InputJsonValue,
        traceId: ctx.traceId,
        flagged: blocked && !result.trace.flags.includes("OUTPUT_BLOCKED") ? [...result.trace.flags, "OUTPUT_BLOCKED"] : result.trace.flags,
        createdAt: now,
      },
    });
    await this.fillJourney(result, ctx);
    return ok(result);
  }
}
