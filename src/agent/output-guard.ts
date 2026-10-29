import { normalizeText } from "./safety/lexicon";

/**
 * Validador de la respuesta del LLM (AGENT_DESIGN.md §6.3). Toda cifra técnica, importe, fecha, folio o
 * afirmación de reserva del texto debe estar respaldada por resultados estructurados de herramientas
 * (o por lo que el propietario acaba de escribir). Si no, la respuesta se reemplaza por una de respaldo.
 */
export interface GuardFacts {
  /** Importes COP de cotizaciones vigentes (subtotal, impuesto, total). */
  amounts: ReadonlySet<number>;
  /** Kilometrajes respaldados: evaluación, perfil, historial, plan validado. */
  kilometers: ReadonlySet<number>;
  /** Meses de intervalos de planes validados y días restantes. */
  periods: ReadonlySet<number>;
  /** Fechas ISO respaldadas (vencimientos, cupos, validez). */
  dates: ReadonlySet<string>;
  folios: ReadonlySet<string>;
  /** Hay una reserva confirmada (con folio del taller) en este journey. */
  bookingConfirmed: boolean;
  /** La última evaluación es UNKNOWN: prohibido afirmar que «está al día». */
  evaluationUnknown: boolean;
  /** Números escritos por el propietario en su último mensaje (puede repetirlos). */
  userNumbers: ReadonlySet<number>;
}

export type GuardViolation =
  | "UNSUPPORTED_AMOUNT"
  | "UNSUPPORTED_KM"
  | "UNSUPPORTED_PERIOD"
  | "UNSUPPORTED_DATE"
  | "UNSUPPORTED_FOLIO"
  | "FALSE_BOOKING_CLAIM"
  | "UP_TO_DATE_CLAIM_ON_UNKNOWN"
  | "CERTIFICATION_CLAIM"
  | "DIAGNOSIS_CLAIM";

export type GuardResult = { ok: true } | { ok: false; violations: GuardViolation[]; offending: string[] };

const NUMBER = String.raw`(\d{1,3}(?:[.,]\d{3})+|\d+)`;
const toInt = (raw: string) => Number(raw.replace(/[.,]/g, ""));

const MONEY_RES = [new RegExp(String.raw`(?:\$|cop)\s?${NUMBER}`, "gi"), new RegExp(String.raw`${NUMBER}\s?(?:cop|pesos)\b`, "gi")];
const KM_RE = new RegExp(String.raw`${NUMBER}\s?(?:km|kms|kil[oó]metros)\b`, "gi");
const PERIOD_RE = new RegExp(String.raw`${NUMBER}\s?(?:mes(?:es)?|d[ií]as?)\b`, "gi");
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DMY_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const FOLIO_RE = /\bFOLIO-[A-Z0-9-]+\b/g;

const BOOKING_CLAIMS = [
  /\b(reserva|cita)\b.{0,30}\b(quedo|queda|esta|ha sido|fue)\b.{0,10}\b(confirmad|reservad|agendad)/g,
  /\b(ya )?(quedo|queda|esta) (reservad|agendad|confirmad)/g,
  /\b(te|le) (reserve|agende|confirme)\b/g,
  /\b(he|ya) (reservado|agendado|confirmado)\b/g,
];

/**
 * Una mención de reserva o folio solo es afirmación si no está negada, condicionada ni ofrecida. Así pasan textos
 * seguros que el prompt exige («la reserva NO queda confirmada hasta que pulses…», «¿quieres que te reserve el
 * primero?», «el taller emite un folio cuando confirmes») y se siguen bloqueando las afirmaciones («ya está
 * confirmada», «te agendé»). Falsos positivos observados con Claude real en la Fase 8A.
 */
const NEGATION_INSIDE = /\b(no|nunca|aun no|todavia no)\b/;
const NON_ASSERTIVE_BEFORE =
  /\b(no|nunca|aun no|todavia no|hasta que|cuando|si|quieres que|quieras que|deseas que|te gustaria que|puedo|podemos|para que|antes de que|una vez|despues de que|apenas|al confirmar|recibiras|recibes|tendras|emite|emitira|te dara|se genera|generara|te llegara)\b(\s+\S+){0,4}\s*$/;

/** Condición que sigue al verbo en la misma oración: «la cita solo queda reservada CUANDO pulses…». */
const CONDITION_AFTER = /^\s*(\S+\s+){0,3}(cuando|hasta que|si|una vez|despues de que|apenas|en cuanto)\b/;

function assertive(sentence: string, index: number, matched: string): boolean {
  if (NEGATION_INSIDE.test(matched)) return false;
  if (CONDITION_AFTER.test(sentence.slice(index + matched.length))) return false;
  return !NON_ASSERTIVE_BEFORE.test(sentence.slice(Math.max(0, index - 45), index));
}

/** Folio presentado como dato existente («tu folio es …», «número de reserva: 123»); mencionar el proceso no lo es. */
const STATED_FOLIO = /\b(tu|su|el) (numero de reserva|folio)( de (tu )?(cita|reserva))? (es|sera|quedo)\b/g;
/**
 * Diagnóstico = atribuir la causa de una falla a una pieza o sistema. «El problema es QUE tu historial no registra…»
 * es una explicación, no un diagnóstico (falso positivo observado con Opus, Fase 8A). Se exige un determinante.
 */
const DIAGNOSIS = [
  /\b(el problema|la falla|la causa|la averia|el dano)\b (es|seria|puede ser|podria ser|parece ser|debe ser|seguramente es|probablemente es) (el|la|los|las|un|una|tu|su)\b/,
  /\b(seguramente|probablemente) (es|sea|son) (el|la|los|las|un|una)\b/,
  /\bes probable que (sea|se trate de) (el|la|un|una)\b/,
  /\bel diagnostico es\b/,
];

/** Negación o reserva expresa del hablante antes de la afirmación: «no puedo decirte que…», «no basta para decir que…». */
const DISCLAIMED_BEFORE = /\b(no|nunca|aun no|todavia no)\b.{0,45}\b(decir|decirte|confirmar|confirmarte|asegurar|asegurarte|afirmar|saber|basta|puedo|podemos|garantizar|certificar)\b/;

/** Mención de una cifra que trajo el propietario para rechazarla o atribuirla, no para afirmarla como precio. */
const AMOUNT_ATTRIBUTION = /\b(te dieron|te dijo|te dijeron|te cotizaron|te informaron|mencionas|mencionaste|dices|me dices|valide|validar|verifique|verificar|revise|revisar|sobre (el|los|la|las)|ese valor|esa cifra)\b/;
/** Verbos con los que una cifra se afirma como precio: con ellos, la atribución no basta. */
const ASSERTED_PRICE = /\b(cuesta|cuestan|vale|valen|sale|salen|precio es|total es|queda en|pagas|pagaras|pagarias|te cobra|te cobran|cobran)\b/;
const NEGATED = /\b(no|nunca|aun no|todavia no|sin)\b/;

const MONTHS: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const NATURAL_DATE_RE = /\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?: (?:de|del) (\d{4}))?/g;

/** Equivalencias numéricas antes de validar: «75 000» y «75 mil» → 75000; «75k km» → 75000. */
export function normalizeNumbers(text: string): string {
  return text
    .replace(/(\d{1,3})((?:[ \u00a0\u202f]\d{3})+)(?!\d)/g, (_, a: string, b: string) => a + b.replace(/[ \u00a0\u202f]/g, ""))
    .replace(/(\d+(?:[.,]\d+)?)\s?mil\b/gi, (_, n: string) => String(Math.round(Number(n.replace(",", ".")) * 1000)))
    .replace(/(\d+(?:[.,]\d+)?)\s?k(?=\s?(?:km|kil))/gi, (_, n: string) => String(Math.round(Number(n.replace(",", ".")) * 1000)));
}

/** Oraciones sin romper números («75.000») ni horas («8:00»). */
function sentences(text: string): string[] {
  return text.split(/[!?¡¿;\n]+|\.(?!\d)|:(?!\d)/).map((x) => x.trim()).filter(Boolean);
}

function collect(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[1]);
}

export function checkOutput(text: string, facts: GuardFacts): GuardResult {
  const violations = new Set<GuardViolation>();
  const offending: string[] = [];
  const flag = (v: GuardViolation, what: string) => {
    violations.add(v);
    offending.push(what);
  };

  const numeric = normalizeNumbers(text);

  for (const raw of sentences(numeric)) {
    const sentence = normalizeText(raw);
    for (const re of MONEY_RES) {
      for (const m of raw.matchAll(new RegExp(re.source, "gi"))) {
        const n = toInt(m[1]);
        if (facts.amounts.has(n)) continue;
        // Una cifra que escribió el propietario puede citarse para rechazarla o atribuirla («no puedo confirmarte los
        // $99.000», «sobre los $99.000 que te dieron»), nunca para presentarla como precio (Fase 8B).
        const before = normalizeText(raw.slice(0, m.index));
        if (facts.userNumbers.has(n) && (NEGATED.test(before) || (AMOUNT_ATTRIBUTION.test(sentence) && !ASSERTED_PRICE.test(sentence)))) continue;
        flag("UNSUPPORTED_AMOUNT", m[1]);
      }
    }
  }
  for (const raw of collect(KM_RE, numeric)) {
    const n = toInt(raw);
    if (!facts.kilometers.has(n) && !facts.userNumbers.has(n)) flag("UNSUPPORTED_KM", raw);
  }
  for (const raw of collect(PERIOD_RE, numeric)) {
    const n = toInt(raw);
    if (!facts.periods.has(n) && !facts.userNumbers.has(n)) flag("UNSUPPORTED_PERIOD", raw);
  }
  for (const m of text.matchAll(ISO_DATE_RE)) {
    if (!facts.dates.has(m[0])) flag("UNSUPPORTED_DATE", m[0]);
  }
  for (const m of text.matchAll(DMY_DATE_RE)) {
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (!facts.dates.has(iso)) flag("UNSUPPORTED_DATE", m[0]);
  }
  // Fechas en lenguaje natural («1 de abril de 2027», «jueves 29 de octubre»): mismo respaldo que las ISO (Fase 8B).
  for (const m of normalizeText(text).matchAll(NATURAL_DATE_RE)) {
    const mmdd = `${String(MONTHS[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const supported = m[3] ? facts.dates.has(`${m[3]}-${mmdd}`) : [...facts.dates].some((d) => d.endsWith(`-${mmdd}`));
    if (!supported) flag("UNSUPPORTED_DATE", m[0]);
  }
  for (const m of text.matchAll(FOLIO_RE)) {
    if (!facts.folios.has(m[0])) flag("UNSUPPORTED_FOLIO", m[0]);
  }

  for (const sentence of sentences(text).map(normalizeText)) {
    if (!facts.bookingConfirmed) {
      // Por oración: la negación o condición de una frase no se extiende a la siguiente.
      for (const re of BOOKING_CLAIMS) {
        for (const m of sentence.matchAll(re)) if (assertive(sentence, m.index ?? 0, m[0])) flag("FALSE_BOOKING_CLAIM", m[0]);
      }
      if (facts.folios.size === 0) {
        for (const m of sentence.matchAll(STATED_FOLIO)) if (assertive(sentence, m.index ?? 0, m[0])) flag("FALSE_BOOKING_CLAIM", m[0]);
      }
    }
    // «Está al día» con evaluación UNKNOWN: se bloquea la afirmación, no la negación expresa del hablante.
    if (facts.evaluationUnknown) {
      for (const m of sentence.matchAll(/\b(esta|estas|va|vas|estaria|estarias) al dia\b/g)) {
        const before = sentence.slice(0, m.index);
        if (/\bno\s*$/.test(before) || DISCLAIMED_BEFORE.test(before)) continue;
        flag("UP_TO_DATE_CLAIM_ON_UNKNOWN", m[0]);
      }
    }
    for (const m of sentence.matchAll(/\bcertific\w*/g)) {
      if (!DISCLAIMED_BEFORE.test(sentence.slice(0, (m.index ?? 0) + m[0].length)) && !NEGATED.test(sentence.slice(0, m.index))) flag("CERTIFICATION_CLAIM", m[0]);
    }
    for (const re of DIAGNOSIS) if (re.test(sentence)) flag("DIAGNOSIS_CLAIM", re.source);
  }

  return violations.size === 0 ? { ok: true } : { ok: false, violations: [...violations], offending };
}

/** Números que el propietario escribió (para aceptar que el asistente los repita). */
export function numbersIn(text: string): Set<number> {
  return new Set([...text.matchAll(new RegExp(NUMBER, "g"))].map((m) => toInt(m[1])));
}

/** Respuesta de respaldo determinista cuando el texto del modelo no supera el validador. */
export const GUARD_FALLBACK_TEXT =
  "No puedo darte esa información en texto con la certeza necesaria. Te muestro solo los datos verificados en las tarjetas; si necesitas algo más, puedo pasarte con un asesor.";
