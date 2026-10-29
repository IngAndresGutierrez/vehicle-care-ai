/**
 * Preclasificador determinista de síntomas críticos (AGENT_DESIGN.md §6.1, EX-02). Se ejecuta ANTES del LLM.
 * Prioriza la sensibilidad: un falso positivo escala a un humano; un falso negativo podría dejar a alguien
 * conduciendo con un riesgo. Lista provisional pendiente de validación por personal técnico (D-24).
 */

export type SafetyCategory =
  | "BRAKES"
  | "STEERING"
  | "FIRE_SMOKE_FUEL"
  | "OVERHEATING"
  | "CRITICAL_WARNING_LIGHT"
  | "TIRES"
  | "BRAKE_FLUID_LEAK";

export const SAFETY_LEXICON_VERSION = "safety-lexicon-v1.1";

/** Minúsculas, sin tildes ni signos, espacios colapsados. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PATTERNS: ReadonlyArray<[SafetyCategory, RegExp]> = [
  ["BRAKES", /\bfrenos?\b.{0,40}\b(se hunde|se hunden|se va al fondo|no frena|no frenan|no responde|no responden|no funciona|no funcionan|no agarra|fall(a|an|o|aron)|no detiene|casi no (frena|detiene|para))/],
  ["BRAKES", /\b(no|casi no) (frena|frenan|detiene)\b/],
  ["BRAKES", /\bpedal\b.{0,30}(hasta el fondo|se va al fondo|se hunde|esponjos|blando|duro de repente)/],
  ["BRAKES", /\b(sin|perdi|perdio|me quede sin) (los )?frenos\b/],
  ["STEERING", /\b(direccion|timon|volante)\b.{0,40}(se (va|fue|bloque|trab|suelt)|bloquead|trabad|duro de repente|no responde|suelto)/],
  ["FIRE_SMOKE_FUEL", /\b(humo|fuego|llamas?|incendi\w*|se prendio el motor)\b/],
  ["FIRE_SMOKE_FUEL", /\b(olor|huele|oliendo) a (gasolina|combustible|quemado)\b/],
  ["FIRE_SMOKE_FUEL", /\b(fuga|gotea|bota|riega)\w*\b.{0,20}\b(gasolina|combustible|acpm|diesel)\b/],
  ["OVERHEATING", /\btemperatura\b.{0,25}(en rojo|al rojo|al maximo|muy alta|se subio|subio)/],
  ["OVERHEATING", /\b(recalent|sobrecalent)\w*/],
  ["OVERHEATING", /\b(bota|sale|echa) (humo blanco|vapor)\b/],
  ["CRITICAL_WARNING_LIGHT", /\b(luz|testigo|bombillo|indicador)\w*\b.{0,15}\broj[oa]s?\b/],
  ["CRITICAL_WARNING_LIGHT", /\b(luz|testigo)\b.{0,10}\b(de )?(aceite|freno|frenos|temperatura)\b.{0,15}\b(encendid|prendid|se prendio|titila)/],
  ["TIRES", /\b(llanta|neumatico|rueda)s?\b.{0,30}(revent|estall|se (salio|sale|solto)|se desinfl\w* (de golpe|rapid))/],
  // v1.1 (Fase 8A): mismo criterio con el verbo antes del sustantivo («se me estalló una llanta»).
  ["TIRES", /\b(revent|estall)\w*\b.{0,20}\b(llanta|neumatico|rueda)s?\b/],
  ["BRAKE_FLUID_LEAK", /\b(liquido|fluido) de frenos?\b.{0,30}(fuga|gotea|se (bota|sale|perdio|acabo))/],
  ["BRAKE_FLUID_LEAK", /\b(fuga|gotea)\w*\b.{0,20}\bliquido de frenos?\b/],
];

export interface SafetyClassification {
  hit: boolean;
  categories: SafetyCategory[];
  lexiconVersion: string;
}

export function classifySafety(text: string): SafetyClassification {
  const normalized = normalizeText(text);
  const categories = [...new Set(PATTERNS.filter(([, re]) => re.test(normalized)).map(([c]) => c))];
  return { hit: categories.length > 0, categories, lexiconVersion: SAFETY_LEXICON_VERSION };
}

/**
 * Plantilla aprobada (borrador rotulado hasta su validación por personal cualificado, A-06/D-25).
 * No diagnostica, no recomienda seguir conduciendo y entrega la referencia del caso.
 */
export function safetyTemplate(caseReference: string | null): string {
  const reference = caseReference ? ` Referencia de tu caso: ${caseReference}.` : "";
  return [
    "Lo que describes puede afectar la seguridad del vehículo.",
    "Te recomendamos no conducirlo mientras persista el síntoma y, si estás en la vía, detenerte en un lugar seguro y pedir asistencia.",
    `Una persona de nuestro equipo revisará tu caso con prioridad urgente.${reference}`,
    "Mientras tanto no podemos continuar con cotizaciones ni reservas por este canal.",
    "[Texto de seguridad provisional pendiente de aprobación por personal técnico]",
  ].join(" ");
}
