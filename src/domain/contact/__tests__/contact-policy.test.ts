import { describe, expect, it } from "vitest";
import type { ConsentFacts } from "../../policies/consent-policy";
import { contactWindowStart, maintenanceCycleKey, planReminder, reminderDedupKey, type ReminderInput } from "../contact-policy";

const granted: ConsentFacts = {
  purpose: "MAINTENANCE_REMINDERS",
  channel: "WHATSAPP",
  isGranted: true,
  events: [{ id: "ev-wa", action: "GRANTED", occurredAt: new Date("2026-09-01T00:00:00Z") }],
};
const POLICY = { policyVersion: "demo-comm-v1", minDaysBetweenReminders: 14, maxRemindersPerCycle: 2 };
const input = (overrides: Partial<ReminderInput> = {}): ReminderInput => ({
  status: "UPCOMING",
  journeyState: "NEED_DETECTED",
  consents: [granted],
  sentInCycle: [],
  today: "2026-10-28",
  cycleKey: "veh:OIL:rule:svc",
  policy: POLICY,
  ...overrides,
});

describe("claves estables de deduplicación (ADR-015)", () => {
  it("el ciclo depende de vehículo, servicio, regla y servicio de referencia; no del reloj", () => {
    expect(maintenanceCycleKey({ vehicleId: "v", serviceCode: "OIL", ruleId: "r", baselineServiceRecordId: "s" })).toBe("v:OIL:r:s");
    expect(maintenanceCycleKey({ vehicleId: "v", serviceCode: "OIL", ruleId: null, baselineServiceRecordId: null })).toBe("v:OIL:NO_RULE:NO_BASELINE");
  });

  it("la ventana es un bloque fijo de días: estable dentro del bloque, distinta en el siguiente", () => {
    const start = contactWindowStart("2026-10-28", 14);
    for (let d = 0; d < 14; d++) {
      const day = new Date(Date.parse(`${start}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
      expect(contactWindowStart(day, 14)).toBe(start);
    }
    const next = new Date(Date.parse(`${start}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(contactWindowStart(next, 14)).toBe(next);
    expect(contactWindowStart("2026-10-28", 0)).toBe("2026-10-28"); // ancho mínimo 1 día
  });

  it("la clave incluye ciclo, versión de política y ventana", () => {
    expect(reminderDedupKey({ cycleKey: "c", policyVersion: "p", windowStart: "2026-10-22" })).toBe("reminder:v1:c:p:2026-10-22");
  });
});

describe("planReminder", () => {
  it("con necesidad, journey contactable y consentimiento → CONTACT con la evidencia", () => {
    const plan = planReminder(input());
    expect(plan).toMatchObject({ kind: "CONTACT", channel: "WHATSAPP", consentEventId: "ev-wa" });
    if (plan.kind === "CONTACT") expect(plan.dedupKey).toMatch(/^reminder:v1:veh:OIL:rule:svc:demo-comm-v1:\d{4}-\d{2}-\d{2}$/);
  });

  it("misma ventana → misma clave aunque cambie el día (re-ejecuciones del job)", () => {
    const start = contactWindowStart("2026-10-28", 14);
    const a = planReminder(input({ today: start }));
    const b = planReminder(input({ today: new Date(Date.parse(`${start}T00:00:00Z`) + 13 * 86_400_000).toISOString().slice(0, 10) }));
    expect(a.kind === "CONTACT" && b.kind === "CONTACT" && a.dedupKey === b.dedupKey).toBe(true);
  });

  it("sin consentimiento → SUPPRESS por CONSENT_REQUIRED, nunca CONTACT", () => {
    expect(planReminder(input({ consents: [] }))).toMatchObject({ kind: "SUPPRESS", reason: "CONSENT_REQUIRED", channel: "WHATSAPP" });
    const revoked = { ...granted, isGranted: false, events: [...granted.events, { id: "ev-r", action: "REVOKED" as const, occurredAt: new Date("2026-10-01T00:00:00Z") }] };
    expect(planReminder(input({ consents: [revoked] }))).toMatchObject({ kind: "SUPPRESS", reason: "CONSENT_REQUIRED" });
  });

  it("tope por ciclo → SUPPRESS por FREQUENCY_CAP", () => {
    expect(planReminder(input({ sentInCycle: ["2026-09-01", "2026-09-20"] }))).toMatchObject({ kind: "SUPPRESS", reason: "FREQUENCY_CAP" });
  });

  it("separación mínima entre envíos → SKIP sin registro", () => {
    expect(planReminder(input({ sentInCycle: ["2026-10-20"] }))).toEqual({ kind: "SKIP", reason: "MIN_INTERVAL" });
    expect(planReminder(input({ sentInCycle: ["2026-10-14"] })).kind).toBe("CONTACT");
  });

  it("sin necesidad o con el journey fuera de los estados contactables → SKIP", () => {
    for (const status of ["NOT_DUE", "NOT_APPLICABLE", "UNKNOWN"] as const) {
      expect(planReminder(input({ status }))).toEqual({ kind: "SKIP", reason: "NOT_ACTIONABLE" });
    }
    for (const journeyState of ["SAFETY_ESCALATED", "CONVERSATION_OPEN", "BOOKED", "HUMAN_REVIEW", "ACTIVATED"] as const) {
      expect(planReminder(input({ journeyState }))).toEqual({ kind: "SKIP", reason: "JOURNEY_STATE" });
    }
  });

  it("es determinista", () => {
    expect(planReminder(input())).toEqual(planReminder(input()));
  });
});
