/**
 * Fechas de calendario de negocio (sin hora) y su relación con instantes.
 * Sin dependencias: Intl resuelve la zona y la aritmética opera sobre días epoch en UTC,
 * de modo que el resultado no depende de la zona horaria del proceso (ADR-013).
 */

/** Fecha de calendario `YYYY-MM-DD`. */
export type IsoLocalDate = string;

/** Zona de negocio del MVP (Colombia, UTC−5 sin horario de verano). */
export const BUSINESS_TIME_ZONE = "America/Bogota";

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

interface Ymd {
  year: number;
  month: number; // 1..12
  day: number;
}

function parse(date: IsoLocalDate): Ymd | null {
  const m = LOCAL_DATE_RE.exec(date);
  if (!m) return null;
  const ymd = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (ymd.month < 1 || ymd.month > 12) return null;
  if (ymd.day < 1 || ymd.day > daysInMonth(ymd.year, ymd.month)) return null;
  return ymd;
}

function mustParse(date: IsoLocalDate): Ymd {
  const ymd = parse(date);
  if (!ymd) throw new RangeError(`Fecha local inválida: ${date}`);
  return ymd;
}

function format({ year, month, day }: Ymd): IsoLocalDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toEpochDay(date: IsoLocalDate): number {
  const { year, month, day } = mustParse(date);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

export function isValidLocalDate(date: unknown): date is IsoLocalDate {
  return typeof date === "string" && parse(date) !== null;
}

/** Suma meses de calendario; si el día no existe en el mes destino se ajusta al último día (D-05). */
export function addMonthsClamped(date: IsoLocalDate, months: number): IsoLocalDate {
  if (!Number.isInteger(months)) throw new RangeError(`Meses no enteros: ${months}`);
  const { year, month, day } = mustParse(date);
  const zeroBased = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  return format({ year: targetYear, month: targetMonth, day: Math.min(day, daysInMonth(targetYear, targetMonth)) });
}

export function addDaysToLocalDate(date: IsoLocalDate, days: number): IsoLocalDate {
  if (!Number.isInteger(days)) throw new RangeError(`Días no enteros: ${days}`);
  const d = new Date((toEpochDay(date) + days) * MS_PER_DAY);
  return format({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/** Días de calendario de `from` a `to` (negativo si `to` es anterior). */
export function daysBetween(from: IsoLocalDate, to: IsoLocalDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function compareLocalDates(a: IsoLocalDate, b: IsoLocalDate): number {
  return Math.sign(daysBetween(b, a));
}

/** Fecha de calendario de un instante en la zona indicada. */
export function toLocalDate(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): IsoLocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return format({ year: get("year"), month: get("month"), day: get("day") });
}
