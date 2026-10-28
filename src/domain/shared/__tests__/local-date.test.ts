import { describe, expect, it } from "vitest";
import { addMonthsClamped, compareLocalDates, daysBetween, isValidLocalDate, toLocalDate } from "../local-date";

describe("local-date", () => {
  it("ME-17 fin de mes: 2026-01-31 + 1 mes = 2026-02-28", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("ME-18 año bisiesto: 2028-02-29 + 12 meses = 2029-02-28", () => {
    expect(addMonthsClamped("2028-02-29", 12)).toBe("2029-02-28");
  });

  it("suma meses cruzando años y conserva el día cuando existe", () => {
    expect(addMonthsClamped("2026-04-01", 12)).toBe("2027-04-01");
    expect(addMonthsClamped("2025-11-30", 3)).toBe("2026-02-28");
    expect(addMonthsClamped("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("cuenta días de calendario con signo", () => {
    expect(daysBetween("2026-10-28", "2027-04-01")).toBe(155);
    expect(daysBetween("2026-10-28", "2026-10-20")).toBe(-8);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("compara fechas locales", () => {
    expect(compareLocalDates("2026-10-28", "2026-10-29")).toBe(-1);
    expect(compareLocalDates("2026-10-29", "2026-10-29")).toBe(0);
    expect(compareLocalDates("2026-10-30", "2026-10-29")).toBe(1);
  });

  it("convierte instantes a fecha de calendario de Bogotá (UTC−5)", () => {
    expect(toLocalDate(new Date("2026-10-29T04:59:59Z"))).toBe("2026-10-28");
    expect(toLocalDate(new Date("2026-10-29T05:00:00Z"))).toBe("2026-10-29");
    expect(toLocalDate(new Date("2026-10-29T04:59:59Z"), "UTC")).toBe("2026-10-29");
  });

  it("valida fechas de calendario estrictas", () => {
    expect(isValidLocalDate("2026-02-28")).toBe(true);
    expect(isValidLocalDate("2026-02-29")).toBe(false);
    expect(isValidLocalDate("2026-13-01")).toBe(false);
    expect(isValidLocalDate("2026-1-01")).toBe(false);
    expect(isValidLocalDate(20261028)).toBe(false);
    expect(() => addMonthsClamped("2026-02-30", 1)).toThrow(RangeError);
  });
});
