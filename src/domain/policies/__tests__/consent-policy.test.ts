import { describe, expect, it } from "vitest";
import { chooseReminderChannel, decideOutboundContact, type ConsentFacts } from "../consent-policy";

const t = (iso: string) => new Date(iso);
const granted = (channel: ConsentFacts["channel"], id = `ev-${channel}`): ConsentFacts => ({
  purpose: "MAINTENANCE_REMINDERS",
  channel,
  isGranted: true,
  events: [{ id, action: "GRANTED", occurredAt: t("2026-09-15T10:00:00Z") }],
});

describe("consent-policy (denegación por defecto)", () => {
  it("permite con evidencia GRANTED vigente y devuelve el evento como prueba", () => {
    expect(decideOutboundContact([granted("WHATSAPP")], "MAINTENANCE_REMINDERS", "WHATSAPP")).toEqual({
      allowed: true,
      consentEventId: "ev-WHATSAPP",
    });
  });

  it("sin registro para la finalidad o el canal → CONSENT_REQUIRED", () => {
    expect(decideOutboundContact([], "MAINTENANCE_REMINDERS", "EMAIL")).toEqual({
      allowed: false,
      reason: "CONSENT_REQUIRED",
      detail: "NO_CONSENT_RECORD",
    });
    // El consentimiento es por finalidad: SERVICE_OPERATIONAL no habilita recordatorios.
    const operational = { ...granted("EMAIL"), purpose: "SERVICE_OPERATIONAL" as const };
    expect(decideOutboundContact([operational], "MAINTENANCE_REMINDERS", "EMAIL").allowed).toBe(false);
    // Y por canal: WhatsApp no habilita email.
    expect(decideOutboundContact([granted("WHATSAPP")], "MAINTENANCE_REMINDERS", "EMAIL").allowed).toBe(false);
  });

  it("el último evento manda: revocado después de otorgado → REVOKED", () => {
    const c: ConsentFacts = {
      ...granted("WHATSAPP"),
      isGranted: false,
      events: [
        { id: "ev-2", action: "REVOKED", occurredAt: t("2026-10-01T00:00:00Z") },
        { id: "ev-1", action: "GRANTED", occurredAt: t("2026-09-01T00:00:00Z") },
      ],
    };
    expect(decideOutboundContact([c], "MAINTENANCE_REMINDERS", "WHATSAPP")).toMatchObject({ detail: "REVOKED" });
  });

  it("re-otorgado después de revocar → permitido con el último evento", () => {
    const c: ConsentFacts = {
      ...granted("WHATSAPP"),
      events: [
        { id: "ev-1", action: "GRANTED", occurredAt: t("2026-09-01T00:00:00Z") },
        { id: "ev-2", action: "REVOKED", occurredAt: t("2026-09-10T00:00:00Z") },
        { id: "ev-3", action: "GRANTED", occurredAt: t("2026-10-01T00:00:00Z") },
      ],
    };
    expect(decideOutboundContact([c], "MAINTENANCE_REMINDERS", "WHATSAPP")).toEqual({ allowed: true, consentEventId: "ev-3" });
  });

  it("sin eventos de evidencia o con proyección contradictoria → falla cerrado", () => {
    expect(decideOutboundContact([{ ...granted("SMS"), events: [] }], "MAINTENANCE_REMINDERS", "SMS")).toMatchObject({
      detail: "NO_EVIDENCE",
    });
    expect(decideOutboundContact([{ ...granted("SMS"), isGranted: false }], "MAINTENANCE_REMINDERS", "SMS")).toMatchObject({
      detail: "PROJECTION_MISMATCH",
    });
  });

  it("el portal no es un canal saliente", () => {
    expect(decideOutboundContact([granted("PORTAL")], "MAINTENANCE_REMINDERS", "PORTAL")).toMatchObject({
      detail: "NOT_OUTBOUND_CHANNEL",
    });
  });

  it("elige el primer canal autorizado según prioridad", () => {
    expect(chooseReminderChannel([granted("SMS"), granted("EMAIL")])).toEqual({
      allowed: true,
      channel: "EMAIL",
      consentEventId: "ev-EMAIL",
    });
  });

  it("sin ningún canal autorizado devuelve el preferido con el motivo, para registrar la supresión", () => {
    expect(chooseReminderChannel([])).toEqual({
      allowed: false,
      channel: "WHATSAPP",
      reason: "CONSENT_REQUIRED",
      detail: "NO_CONSENT_RECORD",
    });
    expect(() => chooseReminderChannel([], [])).toThrow();
  });
});
