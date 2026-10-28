import type { JourneyState } from "./states";

/** Herramientas del agente (AGENT_DESIGN.md §3.2). El Tool Gateway (Fase 5) consulta `allowedTools`. */
export type AgentToolName =
  | "getVehicleProfile"
  | "getServiceHistory"
  | "getMaintenancePlan"
  | "evaluateMaintenance"
  | "recordOdometer"
  | "listWorkshops"
  | "getQuote"
  | "getAvailableSlots"
  | "prepareBooking"
  | "createHumanCase";

/** Herramientas que mueven el journey comercial: nunca disponibles en SAFETY_ESCALATED. */
export const COMMERCIAL_TOOLS: ReadonlySet<AgentToolName> = new Set([
  "listWorkshops",
  "getQuote",
  "getAvailableSlots",
  "prepareBooking",
]);

const READ: readonly AgentToolName[] = ["getVehicleProfile", "getServiceHistory", "getMaintenancePlan"];
// Handoff humano disponible en todo estado activo salvo seguridad (AGENT_DESIGN §5 regla 8; ADR-015).
const HANDOFF: readonly AgentToolName[] = ["createHumanCase"];
const CONVERSATION: readonly AgentToolName[] = [...READ, "recordOdometer", "evaluateMaintenance", ...HANDOFF];

const TOOLS_BY_STATE: Readonly<Record<JourneyState, readonly AgentToolName[]>> = {
  ACTIVATED: [...READ, ...HANDOFF],
  PLAN_PENDING_VERIFICATION: [...READ, ...HANDOFF],
  MONITORING: [...READ, ...HANDOFF],
  NEED_DETECTED: [...READ, ...HANDOFF],
  CONTACT_SUPPRESSED: [...READ, ...HANDOFF],
  CONVERSATION_OPEN: CONVERSATION,
  AWAITING_CONTEXT: CONVERSATION,
  RECOMMENDATION_PRESENTED: [...CONVERSATION, "listWorkshops", "getQuote"],
  QUOTE_PRESENTED: [...CONVERSATION, "listWorkshops", "getQuote", "getAvailableSlots"],
  QUOTE_PENDING_HUMAN: [...READ, ...HANDOFF],
  SLOT_SELECTION: [...READ, "listWorkshops", "getAvailableSlots", "prepareBooking", ...HANDOFF],
  // Ninguna mutación comercial mientras se espera el clic del propietario.
  AWAITING_CONFIRMATION: [...READ, ...HANDOFF],
  BOOKED: [...READ, ...HANDOFF],
  IN_SERVICE: [...READ, ...HANDOFF],
  SERVICE_COMPLETED: [...READ, ...HANDOFF],
  FOLLOW_UP: [...READ, ...HANDOFF],
  HUMAN_REVIEW: [...READ, ...HANDOFF],
  // Solo lectura: el caso de seguridad ya existe y lo atiende un humano.
  SAFETY_ESCALATED: ["getVehicleProfile", "getServiceHistory"],
  CLOSED: [],
};

export function allowedTools(state: JourneyState): readonly AgentToolName[] {
  return TOOLS_BY_STATE[state];
}

export function isToolAllowed(state: JourneyState, tool: AgentToolName): boolean {
  return TOOLS_BY_STATE[state].includes(tool);
}
