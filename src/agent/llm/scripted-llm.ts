import { toLocalDate } from "@/domain/shared/local-date";
import { normalizeText } from "../safety/lexicon";
import type { LlmBlock, LlmInfo, LlmMessage, LlmPort, LlmRequest, LlmResponse } from "./types";

/**
 * ⚠️ SIMULACIÓN DETERMINISTA — NO ES IA GENERATIVA.
 *
 * `ScriptedLlm` implementa `LlmPort` con reglas fijas por palabras clave para tests y demostraciones sin
 * API key. Lee el CONTEXTO_SERVIDOR y los resultados de herramientas del turno y redacta textos solo con
 * cifras tomadas de esos resultados. No entiende lenguaje natural: cualquier frase fuera de sus reglas
 * recibe una respuesta genérica.
 */
export const SCRIPTED_LLM_INFO: LlmInfo = { provider: "SCRIPTED", model: "scripted-llm-v1 (simulación determinista, no es IA generativa)", simulated: true };
export const CONTEXT_HEADER = "CONTEXTO_SERVIDOR";

interface ServerContext {
  journeyState: string;
  allowedTools: string[];
  serviceCode: string;
  memory: {
    workshops: Array<{ workshopId: string; name: string }>;
    activeQuote: { quoteId: string; workshopId: string } | null;
    offeredSlots: Array<{ slotRef: string }>;
  };
}

interface DoneCall {
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  isError: boolean;
}

type Decision = { tool: string; input: Record<string, unknown> } | { text: string };

let counter = 0;

export class ScriptedLlm implements LlmPort {
  readonly info = SCRIPTED_LLM_INFO;

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const ctx = readContext(request.messages);
    const { userText, done } = currentTurn(request.messages);
    const decision = decide(ctx, userText, done);
    const content: LlmBlock[] =
      "tool" in decision ? [{ type: "tool_use", id: `scripted_${++counter}`, name: decision.tool, input: decision.input }] : [{ type: "text", text: decision.text }];
    return { stopReason: "tool" in decision ? "tool_use" : "end_turn", content, usage: { inputTokens: 0, outputTokens: 0 }, servedBy: this.info.model };
  }
}

/** Respuestas fijas en orden: simula un modelo cualquiera (incluso uno manipulado) en tests de guardrails. */
export class SequenceLlm implements LlmPort {
  readonly info: LlmInfo = { provider: "SCRIPTED", model: "sequence-llm (simulación de pruebas)", simulated: true };
  private index = 0;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: ReadonlyArray<LlmBlock[] | (() => never)>) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.responses[Math.min(this.index++, this.responses.length - 1)];
    if (typeof next === "function") next();
    const content = next as LlmBlock[];
    const hasTool = content.some((b) => b.type === "tool_use");
    return { stopReason: hasTool ? "tool_use" : "end_turn", content, usage: { inputTokens: 10, outputTokens: 10 }, servedBy: this.info.model };
  }
}

function readContext(messages: LlmMessage[]): ServerContext {
  const system = [...messages].reverse().find((m) => m.role === "system");
  const text = system?.content.find((b) => b.type === "text");
  const raw = text && text.type === "text" ? text.text.slice(text.text.indexOf("\n") + 1) : "{}";
  try {
    return JSON.parse(raw) as ServerContext;
  } catch {
    return { journeyState: "ACTIVATED", allowedTools: [], serviceCode: "ENGINE_OIL_FILTER", memory: { workshops: [], activeQuote: null, offeredSlots: [] } };
  }
}

/** Último texto del usuario y las herramientas ejecutadas después de él (este turno). */
function currentTurn(messages: LlmMessage[]): { userText: string; done: DoneCall[] } {
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && m.content.some((b) => b.type === "text")) start = i;
  });
  const userBlock = messages[start]?.content.find((b) => b.type === "text");
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const done: DoneCall[] = [];
  for (const m of messages.slice(start + 1)) {
    for (const b of m.content) {
      if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
      if (b.type === "tool_result") {
        const use = uses.get(b.toolUseId);
        let result: Record<string, unknown> = {};
        try {
          result = JSON.parse(b.content) as Record<string, unknown>;
        } catch {
          result = { raw: b.content };
        }
        if (use) done.push({ ...use, result, isError: b.isError });
      }
    }
  }
  return { userText: userBlock && userBlock.type === "text" ? userBlock.text : "", done };
}

const has = (ctx: ServerContext, tool: string) => ctx.allowedTools.includes(tool);
const called = (done: DoneCall[], tool: string) => done.some((d) => d.name === tool);

function slotIndex(text: string): number {
  if (/\b(segund\w*|2)\b/.test(text)) return 1;
  if (/\b(tercer\w*|3)\b/.test(text)) return 2;
  return 0;
}

function decide(ctx: ServerContext, rawText: string, done: DoneCall[]): Decision {
  const text = normalizeText(rawText);
  const last = done.at(-1);

  // ── Encadenamientos tras un resultado ──
  if (last && !last.isError) {
    if (last.name === "recordOdometer" && !called(done, "evaluateMaintenance") && has(ctx, "evaluateMaintenance")) return { tool: "evaluateMaintenance", input: {} };
    if (last.name === "listWorkshops" && /cuanto|cuesta|precio|cotiz|valor/.test(text) && !called(done, "getQuote")) {
      const first = (last.result.workshops as Array<{ workshopId: string }>)[0];
      if (first) return { tool: "getQuote", input: { workshopId: first.workshopId } };
    }
    if (last.name === "evaluateMaintenance" && last.result.status === "UNKNOWN" && last.result.suggestedAction === "HUMAN_REVIEW" && !called(done, "createHumanCase") && has(ctx, "createHumanCase")) {
      const reasons = (last.result.reasons as string[]) ?? [];
      const reason = reasons.some((r) => r.startsWith("PLAN_")) ? "PLAN_NOT_VERIFIED" : reasons.includes("INSUFFICIENT_HISTORY") ? "INSUFFICIENT_HISTORY" : "DATA_CONFLICT";
      return { tool: "createHumanCase", input: { reason, priority: "NORMAL", summary: `El motor de mantenimiento devolvió UNKNOWN (${reasons.join(", ")}); se requiere revisión e inspección.` } };
    }
  }
  if (last) return { text: compose(done) };

  // ── Primer paso del turno: intención por palabras clave ──
  const km = /(\d{1,3}(?:[.,]\d{3})+|\d{4,7})\s*(km|kilometr)/.exec(text) ?? /(\d{1,3}(?: \d{3})+|\d{4,7}) ?(km|kilometr)/.exec(text);
  if (/\b(asesor|humano|una persona|hablar con alguien)\b/.test(text) && has(ctx, "createHumanCase")) {
    return { tool: "createHumanCase", input: { reason: "CUSTOMER_REQUEST", priority: "NORMAL", summary: "El propietario pidió hablar con un asesor." } };
  }
  if (km && has(ctx, "recordOdometer")) return { tool: "recordOdometer", input: { valueKm: Number(km[1].replace(/[^\d]/g, "")) } };
  if (/\b(reserv\w*|agend\w*|apart\w*)\b/.test(text)) {
    const slot = ctx.memory.offeredSlots[slotIndex(text)];
    if (has(ctx, "prepareBooking") && ctx.memory.activeQuote && slot) return { tool: "prepareBooking", input: { quoteId: ctx.memory.activeQuote.quoteId, slotRef: slot.slotRef } };
    return { text: "Para preparar una reserva primero necesito una cotización vigente y que elijas uno de los horarios disponibles." };
  }
  if (/\b(horario\w*|cupo\w*|disponib\w*|otra hora|otros horarios)\b/.test(text)) {
    const workshopId = ctx.memory.activeQuote?.workshopId ?? ctx.memory.workshops[0]?.workshopId;
    if (workshopId) return { tool: "getAvailableSlots", input: { workshopId } };
    return { text: "Primero necesito saber en qué taller quieres el servicio; puedo consultarte una cotización." };
  }
  if (/\b(cuanto|cuesta|precio|cotiz\w*|valor)\b/.test(text)) {
    const workshopId = ctx.memory.workshops[0]?.workshopId;
    return workshopId ? { tool: "getQuote", input: { workshopId } } : { tool: "listWorkshops", input: {} };
  }
  if (/\bhistorial\b/.test(text)) return { tool: "getServiceHistory", input: {} };
  if (/\b(plan|intervalo|cada cuanto)\b/.test(text)) return { tool: "getMaintenancePlan", input: {} };
  if (/\b(mantenimiento|toca|revis\w*|servicio|vence|correa|aceite|cambiar|debo)\b/.test(text) && has(ctx, "evaluateMaintenance")) {
    return { tool: "evaluateMaintenance", input: {} };
  }
  if (/\b(perfil|kilometraje|mi carro|mi vehiculo)\b/.test(text)) return { tool: "getVehicleProfile", input: {} };
  return {
    text: "Puedo revisar qué mantenimiento le corresponde a tu vehículo, consultarte una cotización, mostrarte horarios, preparar una reserva o pasarte con un asesor. ¿Qué necesitas?",
  };
}

// ───────────────────────────── Redacción con datos de herramientas ─────────────────────────────

const cop = (n: number) => `$${n.toLocaleString("es-CO")}`;
const kmFmt = (n: number) => `${n.toLocaleString("es-CO")} km`;
const time = (iso: string) => new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const day = (iso: string) => toLocalDate(new Date(iso));
const SERVICE_LABEL: Record<string, string> = { ENGINE_OIL_FILTER: "cambio de aceite y filtro", TIMING_BELT: "cambio de correa de distribución" };

function compose(done: DoneCall[]): string {
  const parts: string[] = [];
  for (const d of done) {
    if (d.isError) {
      parts.push(String(d.result.message ?? "No fue posible completar la acción."));
      continue;
    }
    parts.push(describe(d));
  }
  return parts.filter(Boolean).join(" ");
}

function describe(d: DoneCall): string {
  const r = d.result as Record<string, never>;
  switch (d.name) {
    case "evaluateMaintenance": {
      const plan = r.plan as unknown as { version: string; sourceRef: string } | null;
      const label = SERVICE_LABEL[r.serviceCode] ?? r.serviceCode;
      const source = plan ? `Según el plan ${plan.version}${plan.sourceRef.startsWith("SYNTHETIC-DEMO") ? " (regla de demostración sintética)" : ""}` : "Sin un plan validado";
      const t = r.technical as unknown as { dueBy: { km: number | null; date: string | null } | null; remaining: { km: number | null; days: number | null } | null; reachedBy: "KM" | "TIME" | "BOTH" | null };
      const limits = [t.dueBy?.km != null ? `a los ${kmFmt(t.dueBy.km)}` : null, t.dueBy?.date ? `el ${t.dueBy.date}` : null].filter(Boolean).join(" o ");
      switch (r.status as string) {
        case "UPCOMING":
          return `${source}, el ${label} está próximo: vence ${limits}${t.remaining?.km != null ? ` y faltan ${kmFmt(t.remaining.km)}` : ""}. ¿Quieres que te consulte una cotización?`;
        case "DUE":
        case "OVERDUE": {
          const byKm = t.reachedBy !== "TIME" && t.dueBy?.km != null ? `por kilometraje (límite: ${kmFmt(t.dueBy.km)})` : null;
          const byTime = t.reachedBy !== "KM" && t.dueBy?.date ? `por tiempo (límite: ${t.dueBy.date})` : null;
          return `${source}, el ${label} ya corresponde ${[byKm, byTime].filter(Boolean).join(" y ")}. ¿Quieres que te consulte una cotización?`;
        }
        case "NOT_DUE":
          return `${source}, el ${label} todavía no corresponde: vence ${limits}.`;
        case "NOT_APPLICABLE":
          return `${source}, el ${label} no aplica a tu vehículo.`;
        default:
          return r.suggestedAction === "CONFIRM_ODOMETER"
            ? "Para evaluarlo necesito confirmar el kilometraje actual. ¿Cuántos kilómetros marca hoy el odómetro?"
            : `No tengo información suficiente para determinar si corresponde el ${label} (${(r.reasons as unknown as string[]).join(", ")}). No puedo recomendar el cambio ni confirmar su estado sin una revisión.`;
      }
    }
    case "createHumanCase":
      return r.reason === "SAFETY_ESCALATION"
        ? `Abrí un caso urgente para que una persona lo revise (referencia ${r.caseId}).`
        : `Abrí un caso para que un asesor lo revise y te contacte (referencia ${r.caseId}).`;
    case "recordOdometer":
      return `Registré ${kmFmt(r.valueKm)} como dato declarado por ti.`;
    case "listWorkshops":
      return `Talleres disponibles: ${(r.workshops as unknown as Array<{ name: string }>).map((w) => w.name).join(", ")}.`;
    case "getQuote":
      return `La cotización del taller es de ${cop(r.totalCop)} (subtotal ${cop(r.subtotalCop)} más impuestos de ${cop(r.taxCop)}), válida hasta el ${day(r.validUntil)}. Es un precio del catálogo simulado de demostración. ¿Te muestro los horarios disponibles?`;
    case "getAvailableSlots": {
      const slots = r.slots as unknown as Array<{ startsAt: string }>;
      return `Horarios disponibles: ${slots.slice(0, 3).map((s, i) => `${i + 1}) ${day(s.startsAt)} a las ${time(s.startsAt)}`).join("; ")}. Dime cuál prefieres.`;
    }
    case "prepareBooking": {
      const s = r.summary as unknown as { startsAt: string; workshopName: string; totalCop: number };
      return `Preparé la solicitud para el ${day(s.startsAt)} a las ${time(s.startsAt)} en ${s.workshopName} por ${cop(s.totalCop)}. Para que el taller la registre debes pulsar «Confirmar reserva» en la tarjeta antes de que caduque.`;
    }
    case "getVehicleProfile": {
      const o = r.odometer as unknown as { valueKm: number; observedAt: string; provenance: string } | null;
      return o ? `Tu vehículo registra ${kmFmt(o.valueKm)} (lectura del ${day(o.observedAt)}, ${o.provenance === "OWNER_DECLARED" ? "declarada por ti" : "verificada"}).` : "No hay lecturas de odómetro registradas.";
    }
    case "getServiceHistory": {
      const s = (r.serviceRecords as unknown as Array<{ serviceCode: string; performedOn: string; odometerKm: number; provenance: string }>)[0];
      return s ? `Último servicio registrado: ${SERVICE_LABEL[s.serviceCode] ?? s.serviceCode} el ${s.performedOn} a los ${kmFmt(s.odometerKm)} (${s.provenance === "WORKSHOP_VERIFIED" ? "acreditado por taller" : "sin verificar por taller"}).` : "No hay servicios registrados.";
    }
    case "getMaintenancePlan": {
      const rules = r.rules as unknown as Array<{ serviceCode: string; intervalKm: number | null; intervalMonths: number | null }>;
      return `Plan ${r.version}${String(r.sourceRef).startsWith("SYNTHETIC-DEMO") ? " (regla de demostración sintética)" : ""}: ${rules
        .map((x) => `${SERVICE_LABEL[x.serviceCode] ?? x.serviceCode} cada ${[x.intervalKm != null ? kmFmt(x.intervalKm) : null, x.intervalMonths != null ? `${x.intervalMonths} meses` : null].filter(Boolean).join(" o ")}`)
        .join("; ")}.`;
    }
    default:
      return "";
  }
}
