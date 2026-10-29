/** Textos en español para códigos estables del dominio. Un código sin traducción se muestra tal cual. */

export const label = (map: Record<string, string>, code: string | null | undefined) => (code ? (map[code] ?? code) : "—");

export const SERVICE: Record<string, string> = {
  ENGINE_OIL_FILTER: "Cambio de aceite y filtro",
  TIMING_BELT: "Correa de distribución",
};

export const STATUS: Record<string, { text: string; tone: Tone }> = {
  NOT_DUE: { text: "Al día", tone: "ok" },
  UPCOMING: { text: "Próximo", tone: "warn" },
  DUE: { text: "Le toca ya", tone: "warn" },
  OVERDUE: { text: "Vencido", tone: "danger" },
  NOT_APPLICABLE: { text: "No aplica", tone: "neutral" },
  UNKNOWN: { text: "Sin datos suficientes", tone: "neutral" },
};

export type Tone = "ok" | "warn" | "danger" | "neutral" | "ink";

export const REASON: Record<string, string> = {
  INVALID_INPUT: "Datos de entrada inválidos",
  PLAN_MISSING: "No hay plan de mantenimiento para este vehículo",
  PLAN_NOT_VERIFIED: "El plan de mantenimiento no está validado",
  ENGINE_UNIDENTIFIED: "El motor no está identificado",
  RULE_MISSING_FOR_SERVICE: "El plan no tiene regla para este servicio",
  RULE_WITHOUT_INTERVAL: "La regla no define intervalo",
  USAGE_CONDITION_REQUIRED: "Falta la condición de uso del vehículo",
  TIMING_DRIVE_UNKNOWN: "No se sabe si el motor usa correa o cadena",
  NOT_APPLICABLE_TIMING_DRIVE: "Este motor no usa correa de distribución",
  CONTRADICTORY_RECORDS: "Hay registros que se contradicen",
  INSUFFICIENT_HISTORY: "No hay constancia de un servicio anterior",
  BASELINE_NOT_DOCUMENTED: "El último servicio no está documentado",
  DELIVERY_BASELINE_NOT_ALLOWED: "La entrega del vehículo no sirve como punto de partida para este servicio",
  ODOMETER_MISSING: "Falta el kilometraje actual",
  ODOMETER_STALE: "El kilometraje registrado es antiguo",
  WITHIN_INTERVAL: "Dentro del intervalo",
  KM_LIMIT_REACHED: "Se alcanzó el límite de kilómetros",
  TIME_LIMIT_REACHED: "Se alcanzó el límite de tiempo",
  KM_WITHIN_LEAD: "Faltan pocos kilómetros para el límite",
  TIME_WITHIN_LEAD: "Faltan pocos días para el límite",
  KM_GRACE_EXCEEDED: "Se superó el margen de kilómetros",
  TIME_GRACE_EXCEEDED: "Se superó el margen de tiempo",
};

export const PROVENANCE: Record<string, string> = {
  WORKSHOP_VERIFIED: "Acreditado por el taller",
  DELIVERY_INSPECTION: "Inspección de entrega",
  PRIOR_OWNER_DOCUMENT: "Documento aportado, sin verificar",
  OWNER_DECLARED: "Declarado por el propietario",
};

export const VERIFICATION: Record<string, string> = { VERIFIED: "Verificado", UNVERIFIED: "Sin verificar", REJECTED: "Rechazado" };

export const JOURNEY: Record<string, string> = {
  ACTIVATED: "Activado",
  PLAN_PENDING_VERIFICATION: "Plan por verificar",
  MONITORING: "En seguimiento",
  NEED_DETECTED: "Necesidad detectada",
  CONTACT_SUPPRESSED: "Contacto suspendido",
  CONVERSATION_OPEN: "Conversación abierta",
  AWAITING_CONTEXT: "Esperando datos del propietario",
  RECOMMENDATION_PRESENTED: "Recomendación presentada",
  QUOTE_PRESENTED: "Cotización presentada",
  QUOTE_PENDING_HUMAN: "Cotización a cargo de un asesor",
  SLOT_SELECTION: "Eligiendo horario",
  AWAITING_CONFIRMATION: "Esperando confirmación",
  BOOKED: "Reservado",
  IN_SERVICE: "En el taller",
  SERVICE_COMPLETED: "Servicio realizado",
  FOLLOW_UP: "Seguimiento",
  HUMAN_REVIEW: "En revisión humana",
  SAFETY_ESCALATED: "Escalado por seguridad",
  CLOSED: "Cerrado",
};

/** Quién debe actuar en cada estado del journey. */
export const RESPONSIBLE: Record<string, string> = {
  ACTIVATED: "Sistema",
  PLAN_PENDING_VERIFICATION: "Postventa",
  MONITORING: "Sistema",
  NEED_DETECTED: "Sistema",
  CONTACT_SUPPRESSED: "Sistema",
  CONVERSATION_OPEN: "Asistente",
  AWAITING_CONTEXT: "Propietario",
  RECOMMENDATION_PRESENTED: "Propietario",
  QUOTE_PRESENTED: "Propietario",
  QUOTE_PENDING_HUMAN: "Asesor",
  SLOT_SELECTION: "Propietario",
  AWAITING_CONFIRMATION: "Propietario",
  BOOKED: "Taller",
  IN_SERVICE: "Taller",
  SERVICE_COMPLETED: "Sistema",
  FOLLOW_UP: "Asesor",
  HUMAN_REVIEW: "Asesor",
  SAFETY_ESCALATED: "Asesor",
  CLOSED: "Nadie",
};

export const CASE_REASON: Record<string, string> = {
  INSUFFICIENT_HISTORY: "Historial insuficiente",
  PLAN_NOT_VERIFIED: "Plan no validado",
  SAFETY_ESCALATION: "Síntoma de seguridad",
  QUOTE_UNAVAILABLE: "Cotización no disponible",
  BOOKING_FAILURE: "Falla en la reserva",
  CUSTOMER_REQUEST: "Solicitud del cliente",
  DATA_CONFLICT: "Datos en conflicto",
};

export const PRIORITY: Record<string, { text: string; tone: Tone }> = {
  LOW: { text: "Baja", tone: "neutral" },
  NORMAL: { text: "Normal", tone: "ink" },
  HIGH: { text: "Alta", tone: "warn" },
  URGENT: { text: "Urgente", tone: "danger" },
};

export const CASE_STATUS: Record<string, string> = { OPEN: "Abierto", ASSIGNED: "Asignado", RESOLVED: "Resuelto", CLOSED: "Cerrado" };

export const OUTCOME: Record<string, string> = {
  CLEARED_FOR_SERVICE: "Habilitar el agendamiento",
  REEVALUATE: "Reevaluar con los datos actuales",
  CLOSE: "Cerrar el caso",
};

export const BOOKING_STATUS: Record<string, string> = { PENDING: "Pendiente de respuesta del taller", CONFIRMED: "Confirmada", FAILED: "Fallida", CANCELLED: "Cancelada" };

export const TOOL: Record<string, string> = {
  getVehicleProfile: "Perfil del vehículo",
  getServiceHistory: "Historial de servicios",
  getMaintenancePlan: "Plan de mantenimiento",
  evaluateMaintenance: "Evaluación del motor de reglas",
  recordOdometer: "Registro de kilometraje",
  listWorkshops: "Talleres disponibles",
  getQuote: "Cotización",
  getAvailableSlots: "Horarios disponibles",
  prepareBooking: "Preparar reserva",
  createHumanCase: "Abrir caso humano",
};

/** Fuente del dato: sistemas internos (base propia) o simulados (MOCK). */
export const SOURCE: Record<string, string> = { MOCK: "Sistema simulado", INTERNAL: "Sistema interno" };

export const ROLE: Record<string, string> = { OWNER: "Propietario", ADVISOR: "Asesor", COMPLIANCE: "Compliance", SYSTEM: "Sistema", AGENT: "Asistente", SYSTEM_AGENT: "Asistente", SYSTEM_JOB: "Proceso automático", WORKSHOP_COORDINATOR: "Taller", TECHNICIAN: "Taller", UNKNOWN: "Sin identificar" };

const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const km = new Intl.NumberFormat("es-CO");
const dateFmt = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Bogota" });
const dateTimeFmt = new Intl.DateTimeFormat("es-CO", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });

export const fmtCop = (v: number) => cop.format(v);
export const fmtKm = (v: number) => `${km.format(v)} km`;
export const fmtNum = (v: number) => km.format(v);
/** Fechas locales (YYYY-MM-DD) se fijan al mediodía de Bogotá para no correr de día. */
export const fmtDate = (v: string) => dateFmt.format(new Date(v.length === 10 ? `${v}T12:00:00-05:00` : v));
export const fmtDateTime = (v: string) => dateTimeFmt.format(new Date(v));
export const isSyntheticRef = (ref: string | null | undefined) => !!ref && ref.startsWith("SYNTHETIC-DEMO:");

export const EVENT: Record<string, string> = {
  EVALUATED: "Motor de reglas evaluó el servicio",
  REEVALUATED: "Reevaluación",
  PLAN_VALIDATED: "Plan validado",
  CONTACT_SENT: "Recordatorio enviado",
  CONTACT_SUPPRESSED: "Recordatorio suprimido",
  OWNER_OPENED: "El propietario abrió la conversación",
  ODOMETER_RECORDED: "Kilometraje registrado",
  RECOMMENDATION_SHOWN: "Recomendación presentada",
  QUOTE_ISSUED: "Cotización emitida",
  SLOTS_LISTED: "Horarios consultados",
  BOOKING_INTENT_CREATED: "Reserva preparada",
  INTENT_EXPIRED: "Reserva preparada vencida",
  BOOKING_CONFIRMED: "Reserva confirmada",
  BOOKING_FAILED: "Reserva fallida",
  BOOKING_CANCELLED: "Reserva cancelada",
  HUMAN_CASE_OPENED: "Caso humano abierto",
  SAFETY_SIGNAL: "Señal de seguridad",
  CASE_RESOLVED_BY_HUMAN: "Caso resuelto por una persona",
  WORK_ORDER_OPENED: "Orden de trabajo abierta",
  WORK_ORDER_COMPLETED: "Orden de trabajo cerrada",
  FOLLOW_UP_TIMEOUT: "Seguimiento vencido",
  FEEDBACK_RECEIVED: "Opinión recibida",
};

export const ACCESS_BASIS: Record<string, string> = {
  ACTIVE_OWNERSHIP: "Titular del vehículo",
  PORTFOLIO_ASSIGNMENT: "Vehículo en la cartera del asesor",
  CASE_ASSIGNMENT: "Caso asignado al asesor",
  AUDIT_JUSTIFIED: "Consulta de auditoría justificada",
};
