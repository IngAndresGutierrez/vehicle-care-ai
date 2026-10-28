import { describe, expect, it } from "vitest";
import { hashToken, generateConfirmationToken } from "@/infra/tokens";
import { mapRawError, RAW_ERROR_MAP } from "../mock-workshop-adapter";

describe("capa anticorrupción del taller (mapeo de errores)", () => {
  it("traduce cada código del proveedor a un error tipado del dominio", () => {
    expect(mapRawError("CUPO_NO_DISPONIBLE")).toEqual({ code: "SLOT_CONFLICT", retryable: false, raw: "CUPO_NO_DISPONIBLE" });
    expect(mapRawError("COTIZACION_VENCIDA")).toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(mapRawError("SIN_CUPOS")).toMatchObject({ code: "NO_SLOTS" });
    expect(mapRawError("SIN_TARIFA")).toMatchObject({ code: "QUOTE_UNAVAILABLE" });
    expect(mapRawError("SERVICIO_NO_DISPONIBLE")).toEqual({ code: "WORKSHOP_UNAVAILABLE", retryable: true, raw: "SERVICIO_NO_DISPONIBLE" });
  });

  it("un timeout es resultado incierto, no un fallo ni un éxito", () => {
    expect(mapRawError("TIEMPO_AGOTADO")).toEqual({ code: "OUTCOME_UNCERTAIN", retryable: false, raw: "TIEMPO_AGOTADO" });
  });

  it("un código desconocido nunca se interpreta como éxito", () => {
    expect(mapRawError("ALGO_NUEVO")).toEqual({ code: "WORKSHOP_UNAVAILABLE", retryable: true, raw: "ALGO_NUEVO" });
  });

  it("todos los códigos del proveedor tienen traducción", () => {
    expect(Object.keys(RAW_ERROR_MAP)).toHaveLength(12);
  });
});

describe("tokens de confirmación", () => {
  it("token aleatorio de 256 bits en base64url; solo su sha256 se persiste", () => {
    const a = generateConfirmationToken();
    const b = generateConfirmationToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
  });
});
