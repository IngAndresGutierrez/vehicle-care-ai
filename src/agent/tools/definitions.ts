import { z } from "zod";
import type { AgentToolName } from "@/domain/journey";
import type { LlmToolDefinition } from "../llm/types";

/**
 * Catálogo de herramientas del agente (AGENT_DESIGN.md §3.2). Esquemas estrictos: ningún campo extra, y
 * ninguna herramienta acepta identidad, vehículo ni traza (los inyecta el servidor). No existe herramienta
 * para confirmar reservas, cerrar órdenes ni modificar planes. Todas las propiedades son obligatorias.
 */
const id = z.string().min(1).max(80);

export const TOOL_SCHEMAS = {
  getVehicleProfile: z.object({}).strict(),
  getServiceHistory: z.object({}).strict(),
  getMaintenancePlan: z.object({}).strict(),
  evaluateMaintenance: z.object({}).strict(),
  recordOdometer: z.object({ valueKm: z.number().int().min(0).max(2_000_000) }).strict(),
  listWorkshops: z.object({}).strict(),
  getQuote: z.object({ workshopId: id }).strict(),
  getAvailableSlots: z.object({ workshopId: id }).strict(),
  prepareBooking: z.object({ quoteId: id, slotRef: id }).strict(),
  createHumanCase: z
    .object({
      reason: z.enum(["INSUFFICIENT_HISTORY", "PLAN_NOT_VERIFIED", "SAFETY_ESCALATION", "QUOTE_UNAVAILABLE", "BOOKING_FAILURE", "CUSTOMER_REQUEST", "DATA_CONFLICT"]),
      priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
      summary: z.string().min(1).max(500),
    })
    .strict(),
} satisfies Record<AgentToolName, z.ZodType>;

export type ToolInputs = { [K in AgentToolName]: z.infer<(typeof TOOL_SCHEMAS)[K]> };

const DESCRIPTIONS: Record<AgentToolName, string> = {
  getVehicleProfile: "Perfil del vehículo de esta sesión: especificación, odómetro con procedencia y antigüedad. Sin datos personales.",
  getServiceHistory: "Historial de servicios y lecturas de odómetro del vehículo, con procedencia (taller, declarado) y origen (real o sintético).",
  getMaintenancePlan: "Plan técnico VALIDADO aplicable al vehículo, con versión, fuente e intervalos. Si no hay plan validado devuelve PLAN_NOT_VERIFIED.",
  evaluateMaintenance: "Evalúa con el motor determinista si el servicio de esta sesión corresponde (UPCOMING, DUE, OVERDUE, NOT_DUE, UNKNOWN). Úsalo antes de recomendar.",
  recordOdometer: "Registra el kilometraje que el propietario acaba de declarar en este mensaje. Queda como dato declarado, no verificado.",
  listWorkshops: "Talleres que ofrecen el servicio de esta sesión.",
  getQuote: "Solicita al taller la cotización del servicio para este vehículo. Única fuente válida de precios.",
  getAvailableSlots: "Horarios disponibles del taller para el servicio (próximos 7 días).",
  prepareBooking: "Prepara una intención de reserva con la cotización vigente y el horario elegido. NO reserva: el propietario debe confirmarla con un clic fuera del chat.",
  createHumanCase: "Abre un caso para una persona del equipo: incertidumbre, falta de datos, petición del cliente o seguridad (SAFETY_ESCALATION con prioridad URGENT).",
};

/** Orden estable (alfabético): el array de herramientas no cambia entre turnos (prefijo estable, ADR-018). */
export const AGENT_TOOL_NAMES = (Object.keys(TOOL_SCHEMAS) as AgentToolName[]).sort();

/** Palabras clave de rango que se omiten en el esquema enviado al modelo; el gateway las impone con Zod. */
const RANGE_KEYWORDS = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]);

function stripRangeKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripRangeKeywords);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).filter(([k]) => !RANGE_KEYWORDS.has(k)).map(([k, v]) => [k, stripRangeKeywords(v)]));
  }
  return node;
}

export const LLM_TOOL_DEFINITIONS: LlmToolDefinition[] = AGENT_TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: stripRangeKeywords(z.toJSONSchema(TOOL_SCHEMAS[name])) as Record<string, unknown>,
}));

export function isAgentTool(name: string): name is AgentToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
}
