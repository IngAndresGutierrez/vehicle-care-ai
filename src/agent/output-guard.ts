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
  /\b(reserva|cita)\b.{0,30}\b(quedo|queda|esta|ha sido|fue)\b.{0,10}\b(confirmad|reservad|agendad)/,
  /\b(ya )?(quedo|queda|esta) (reservad|agendad|confirmad)/,
  /\b(te|le) (reserve|agende|confirme)\b/,
  /\b(he|ya) (reservado|agendado|confirmado)\b/,
];
const DIAGNOSIS = [/\b(el problema es|seguramente es|debe ser|es probable que sea|el diagnostico es)\b/];

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

  for (const re of MONEY_RES) {
    for (const raw of collect(re, text)) {
      const n = toInt(raw);
      if (!facts.amounts.has(n)) flag("UNSUPPORTED_AMOUNT", raw);
    }
  }
  for (const raw of collect(KM_RE, text)) {
    const n = toInt(raw);
    if (!facts.kilometers.has(n) && !facts.userNumbers.has(n)) flag("UNSUPPORTED_KM", raw);
  }
  for (const raw of collect(PERIOD_RE, text)) {
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
  for (const m of text.matchAll(FOLIO_RE)) {
    if (!facts.folios.has(m[0])) flag("UNSUPPORTED_FOLIO", m[0]);
  }

  const normalized = normalizeText(text);
  if (!facts.bookingConfirmed) {
    for (const re of BOOKING_CLAIMS) if (re.test(normalized)) flag("FALSE_BOOKING_CLAIM", re.source);
    if (/\bfolio\b/.test(normalized) && facts.folios.size === 0) flag("FALSE_BOOKING_CLAIM", "folio");
  }
  if (facts.evaluationUnknown && /\b(esta|estas|va|vas) al dia\b/.test(normalized)) flag("UP_TO_DATE_CLAIM_ON_UNKNOWN", "al dia");
  if (/\bcertific\w*/.test(normalized)) flag("CERTIFICATION_CLAIM", "certific");
  for (const re of DIAGNOSIS) if (re.test(normalized)) flag("DIAGNOSIS_CLAIM", re.source);

  return violations.size === 0 ? { ok: true } : { ok: false, violations: [...violations], offending };
}

/** Números que el propietario escribió (para aceptar que el asistente los repita). */
export function numbersIn(text: string): Set<number> {
  return new Set([...text.matchAll(new RegExp(NUMBER, "g"))].map((m) => toInt(m[1])));
}

/** Respuesta de respaldo determinista cuando el texto del modelo no supera el validador. */
export const GUARD_FALLBACK_TEXT =
  "No puedo darte esa información en texto con la certeza necesaria. Te muestro solo los datos verificados en las tarjetas; si necesitas algo más, puedo pasarte con un asesor.";
