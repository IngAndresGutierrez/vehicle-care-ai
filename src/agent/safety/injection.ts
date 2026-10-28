import { normalizeText } from "./lexicon";

/**
 * Señales heurísticas de manipulación (AGENT_DESIGN.md §6.2). Solo marcan el mensaje para métricas y trazas:
 * la defensa real son los controles en código (contexto inyectado por el servidor, herramientas sin parámetros
 * de identidad, guardias de estado y validador de salida). Nunca bloquean por sí solas.
 */
export type InjectionFlag = "INJECTION_SUSPECT" | "THIRD_PARTY_DATA_REQUEST" | "TOOL_ESCALATION_REQUEST";

const RULES: ReadonlyArray<[InjectionFlag, RegExp]> = [
  ["INJECTION_SUSPECT", /\bignora\w* (todas )?(tus|las|estas)? ?(instrucciones|reglas|indicaciones)/],
  ["INJECTION_SUSPECT", /\b(system prompt|prompt del sistema|instrucciones del sistema|mensaje de sistema)\b/],
  ["INJECTION_SUSPECT", /\b(ahora eres|actua como|modo (desarrollador|dios|admin|administrador)|jailbreak)\b/],
  ["THIRD_PARTY_DATA_REQUEST", /\b(otro|otra) (vehiculo|carro|cliente|propietario|persona)\b/],
  ["THIRD_PARTY_DATA_REQUEST", /\bplaca\b.{0,6}\b[a-z]{3} ?\d{2,3}[a-z]?\b/],
  ["THIRD_PARTY_DATA_REQUEST", /\b(vin|cedula|documento) (de|del) (otro|otra|un)\b/],
  ["TOOL_ESCALATION_REQUEST", /\b(confirmbooking|completeworkorder|ejecuta la herramienta|llama a la herramienta|aplica (un |el )?descuento)\b/],
];

export function detectInjection(text: string): InjectionFlag[] {
  const normalized = normalizeText(text);
  return [...new Set(RULES.filter(([, re]) => re.test(normalized)).map(([flag]) => flag))];
}
