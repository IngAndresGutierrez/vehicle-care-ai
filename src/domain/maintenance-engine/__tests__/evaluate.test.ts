import { describe, expect, it } from "vitest";
import { evaluate } from "../evaluate";
import type { EvaluationInput, MaintenanceRuleInput, PlanVersionInput } from "../types";
import {
  BELT,
  DEMO_NOW,
  DEMO_OIL_RULE,
  DEMO_PLAN,
  DEMO_POLICIES,
  OIL,
  odometerReading,
  serviceRecord,
  v1OilInput,
  v2BeltInput,
} from "../__fixtures__/synthetic-demo";

const run = (input: EvaluationInput, now: Date = DEMO_NOW) => evaluate(input, DEMO_POLICIES, now);
const withKm = (valueKm: number) => v1OilInput({ odometer: odometerReading({ valueKm }) });
const planWith = (rules: MaintenanceRuleInput[], overrides: Partial<PlanVersionInput> = {}): PlanVersionInput => ({
  ...DEMO_PLAN,
  rules,
  ...overrides,
});

function expectUnknownWithoutFigures(result: ReturnType<typeof run>) {
  expect(result.status).toBe("UNKNOWN");
  expect(result.technical).toEqual({ status: "UNKNOWN", dueBy: null, remaining: null, reachedBy: null });
  expect(result.communication).toBeNull();
}

describe("Maintenance Engine — vencimiento por km y tiempo", () => {
  it("ME-01 ejemplo del PRD: 70.000 km @2026-04-01, lectura 74.200 → UPCOMING por 800 km", () => {
    const r = run(v1OilInput());
    expect(r.status).toBe("UPCOMING");
    expect(r.technical).toEqual({
      status: "NOT_DUE",
      dueBy: { km: 75_000, date: "2027-04-01" },
      remaining: { km: 800, days: 155 },
      reachedBy: null,
    });
    expect(r.communication).toEqual({ status: "UPCOMING", policyVersion: "demo-comm-v1", triggeredBy: "KM" });
    expect(r.reasons).toEqual(["WITHIN_INTERVAL", "KM_WITHIN_LEAD"]);
    expect(r.suggestedAction).toBe("OFFER_QUOTE");
    expect(r.requiresOdometerConfirmation).toBe(false);
    expect(r.plan?.version).toBe("demo-2026.10-r1");
    expect(r.ruleId).toBe("rule-demo-oil");
  });

  it("ME-02 lectura 72.000 → NOT_DUE sin acción", () => {
    const r = run(withKm(72_000));
    expect(r.status).toBe("NOT_DUE");
    expect(r.technical.remaining).toEqual({ km: 3_000, days: 155 });
    expect(r.communication?.triggeredBy).toBeNull();
    expect(r.suggestedAction).toBe("NONE");
  });

  it("ME-03 lectura 75.000 exacta → DUE (el límite es inclusivo)", () => {
    const r = run(withKm(75_000));
    expect(r.status).toBe("DUE");
    expect(r.technical.status).toBe("DUE");
    expect(r.technical.reachedBy).toBe("KM");
    expect(r.technical.remaining?.km).toBe(0);
    expect(r.reasons).toContain("KM_LIMIT_REACHED");
  });

  it("ME-04 lectura 75.499 → DUE (dentro de la gracia de comunicación)", () => {
    expect(run(withKm(75_499)).status).toBe("DUE");
  });

  it("ME-05 lectura 75.500 → OVERDUE; el estado técnico sigue siendo DUE", () => {
    const r = run(withKm(75_500));
    expect(r.status).toBe("OVERDUE");
    expect(r.technical.status).toBe("DUE");
    expect(r.communication).toEqual({ status: "OVERDUE", policyVersion: "demo-comm-v1", triggeredBy: "KM" });
    expect(r.reasons).toEqual(["KM_LIMIT_REACHED", "KM_GRACE_EXCEEDED"]);
  });

  it("ME-06 por tiempo: último servicio 2025-11-15 → UPCOMING por fecha (18 días)", () => {
    const r = run(
      v1OilInput({
        lastService: serviceRecord({ performedOn: "2025-11-15" }),
        odometer: odometerReading({ valueKm: 71_000 }),
      }),
    );
    expect(r.status).toBe("UPCOMING");
    expect(r.communication?.triggeredBy).toBe("TIME");
    expect(r.technical.dueBy).toEqual({ km: 75_000, date: "2026-11-15" });
    expect(r.technical.remaining).toEqual({ km: 4_000, days: 18 });
  });

  it("ME-07 por tiempo: vence exactamente hoy (2025-10-28 + 12 meses) → DUE", () => {
    const r = run(
      v1OilInput({
        lastService: serviceRecord({ performedOn: "2025-10-28" }),
        odometer: odometerReading({ valueKm: 71_000 }),
      }),
    );
    expect(r.status).toBe("DUE");
    expect(r.technical.reachedBy).toBe("TIME");
    expect(r.technical.remaining?.days).toBe(0);
    expect(r.reasons).toContain("TIME_LIMIT_REACHED");
  });

  it("ME-08 KM en aviso y TIEMPO vencido → DUE por tiempo (gana el peor)", () => {
    const r = run(v1OilInput({ lastService: serviceRecord({ performedOn: "2025-10-20" }) }));
    expect(r.status).toBe("DUE");
    expect(r.technical.reachedBy).toBe("TIME");
    expect(r.communication?.triggeredBy).toBe("TIME");
    expect(r.technical.remaining).toEqual({ km: 800, days: -8 });
  });

  it("ME-26 regla solo por km: no se inventa fecha", () => {
    const kmOnly = { ...DEMO_OIL_RULE, intervalMonths: null };
    const r = run(v1OilInput({ plan: planWith([kmOnly]) }));
    expect(r.status).toBe("UPCOMING");
    expect(r.technical.dueBy).toEqual({ km: 75_000, date: null });
    expect(r.technical.remaining).toEqual({ km: 800, days: null });
  });

  it("vencido por km y tiempo a la vez → reachedBy BOTH", () => {
    const r = run(
      v1OilInput({
        lastService: serviceRecord({ performedOn: "2025-10-01" }),
        odometer: odometerReading({ valueKm: 75_100 }),
      }),
    );
    expect(r.technical.reachedBy).toBe("BOTH");
    expect(r.status).toBe("DUE");
  });
});

describe("Maintenance Engine — identidad técnica e incertidumbre (UNKNOWN, AC03)", () => {
  it("ME-09 sin plan → UNKNOWN[PLAN_MISSING] y revisión humana", () => {
    const r = run(v1OilInput({ plan: null }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["PLAN_MISSING"]);
    expect(r.suggestedAction).toBe("HUMAN_REVIEW");
  });

  it("ME-10 plan en DRAFT → UNKNOWN[PLAN_NOT_VERIFIED]", () => {
    const r = run(v1OilInput({ plan: { ...DEMO_PLAN, status: "DRAFT" } }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["PLAN_NOT_VERIFIED"]);
  });

  it("ME-10b plan RETIRED → UNKNOWN[PLAN_NOT_VERIFIED]", () => {
    expect(run(v1OilInput({ plan: { ...DEMO_PLAN, status: "RETIRED" } })).reasons).toEqual(["PLAN_NOT_VERIFIED"]);
  });

  it("ME-11 motor no identificado → UNKNOWN[ENGINE_UNIDENTIFIED]", () => {
    const r = run(v1OilInput({ spec: { engineCode: null, timingDrive: "CHAIN", market: "CO" } }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["ENGINE_UNIDENTIFIED"]);
  });

  it("ME-12 sin regla para el servicio → UNKNOWN[RULE_MISSING_FOR_SERVICE]", () => {
    const r = run(v1OilInput({ serviceCode: "BRAKE_FLUID", lastService: null }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["RULE_MISSING_FOR_SERVICE"]);
  });

  it("regla sin ningún intervalo → UNKNOWN[RULE_WITHOUT_INTERVAL]", () => {
    const empty = { ...DEMO_OIL_RULE, intervalKm: null, intervalMonths: null };
    expect(run(v1OilInput({ plan: planWith([empty]) })).reasons).toEqual(["RULE_WITHOUT_INTERVAL"]);
  });

  it("ME-14 la regla exige condición de uso y no se conoce → UNKNOWN[USAGE_CONDITION_REQUIRED]", () => {
    const rule = { ...DEMO_OIL_RULE, requiresUsageCondition: true };
    const r = run(v1OilInput({ plan: planWith([rule]), usageCondition: null }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["USAGE_CONDITION_REQUIRED"]);
  });

  it("ME-14b con reglas por condición de uso se elige la de la condición declarada", () => {
    const normal = { ...DEMO_OIL_RULE, ruleId: "rule-normal", usageCondition: "NORMAL" as const };
    const severe = { ...DEMO_OIL_RULE, ruleId: "rule-severe", usageCondition: "SEVERE" as const, intervalKm: 2_500 };
    const r = run(v1OilInput({ plan: planWith([normal, severe]), usageCondition: "SEVERE" }));
    expect(r.ruleId).toBe("rule-severe");
    expect(r.technical.dueBy?.km).toBe(72_500);
    expect(r.status).toBe("OVERDUE");
  });
});

describe("Maintenance Engine — historial y línea base", () => {
  it("ME-13 sin último servicio → UNKNOWN[INSUFFICIENT_HISTORY]; no usa 0 km ni la fecha de compra", () => {
    const r = run(v1OilInput({ lastService: null }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["INSUFFICIENT_HISTORY"]);
    expect(r.suggestedAction).toBe("HUMAN_REVIEW");
  });

  it("ME-13b alistamiento de entrega sin permiso de la regla (D-04) → INSUFFICIENT_HISTORY", () => {
    const r = run(v1OilInput({ lastService: serviceRecord({ provenance: "DELIVERY_INSPECTION" }) }));
    expect(r.reasons).toEqual(["INSUFFICIENT_HISTORY", "DELIVERY_BASELINE_NOT_ALLOWED"]);
  });

  it("ME-13c alistamiento de entrega permitido por la regla → se evalúa", () => {
    const rule = { ...DEMO_OIL_RULE, allowDeliveryBaseline: true };
    const r = run(
      v1OilInput({ plan: planWith([rule]), lastService: serviceRecord({ provenance: "DELIVERY_INSPECTION" }) }),
    );
    expect(r.status).toBe("UPCOMING");
  });

  it("ME-13d servicio solo declarado por el propietario no es línea base (D-29)", () => {
    const r = run(v1OilInput({ lastService: serviceRecord({ provenance: "OWNER_DECLARED" }) }));
    expect(r.reasons).toEqual(["INSUFFICIENT_HISTORY", "BASELINE_NOT_DOCUMENTED"]);
  });

  it("ME-15 km del último servicio mayor que una lectura posterior → CONTRADICTORY_RECORDS", () => {
    const r = run(v1OilInput({ lastService: serviceRecord({ odometerKm: 76_000 }) }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["CONTRADICTORY_RECORDS"]);
    expect(r.decisionTrace.find((s) => s.step === "consistency")?.detail).toEqual({
      contradictions: ["SERVICE_KM_ABOVE_LATER_READING"],
    });
  });

  it("ME-16 historial de odómetro decreciente → CONTRADICTORY_RECORDS", () => {
    const r = run(
      v1OilInput({
        odometerHistory: [
          { valueKm: 70_000, observedAt: "2026-04-01T10:00:00-05:00" },
          { valueKm: 80_000, observedAt: "2026-06-01T10:00:00-05:00" },
        ],
      }),
    );
    expect(r.reasons).toEqual(["CONTRADICTORY_RECORDS"]);
  });

  it("ME-20 lectura con fecha futura → CONTRADICTORY_RECORDS", () => {
    const r = run(v1OilInput({ odometer: odometerReading({ observedAt: "2026-10-29T10:00:00-05:00" }) }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["CONTRADICTORY_RECORDS"]);
  });

  it("servicio con fecha futura → CONTRADICTORY_RECORDS", () => {
    const r = run(v1OilInput({ lastService: serviceRecord({ performedOn: "2026-10-29" }) }));
    expect(r.reasons).toEqual(["CONTRADICTORY_RECORDS"]);
  });
});

describe("Maintenance Engine — odómetro obsoleto o ausente", () => {
  const sixtyDaysAgo = "2026-08-29T10:00:00-05:00";

  it("ME-24 lectura de hace 60 días que no alcanza el límite → UNKNOWN[ODOMETER_STALE], pedir km", () => {
    const r = run(v1OilInput({ odometer: odometerReading({ valueKm: 72_000, observedAt: sixtyDaysAgo }) }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["ODOMETER_STALE"]);
    expect(r.requiresOdometerConfirmation).toBe(true);
    expect(r.suggestedAction).toBe("CONFIRM_ODOMETER");
  });

  it("ME-25 lectura de hace 60 días que ya alcanza el límite → DUE concluyente (cota inferior)", () => {
    const r = run(v1OilInput({ odometer: odometerReading({ valueKm: 75_200, observedAt: sixtyDaysAgo }) }));
    expect(r.status).toBe("DUE");
    expect(r.technical.reachedBy).toBe("KM");
    expect(r.requiresOdometerConfirmation).toBe(true);
    expect(r.reasons).toEqual(["KM_LIMIT_REACHED", "ODOMETER_STALE"]);
    expect(r.suggestedAction).toBe("OFFER_QUOTE");
  });

  it("lectura justo en el límite de antigüedad (30 días) sigue siendo concluyente", () => {
    const r = run(
      v1OilInput({ odometer: odometerReading({ valueKm: 72_000, observedAt: "2026-09-28T10:00:00-05:00" }) }),
    );
    expect(r.status).toBe("NOT_DUE");
    expect(r.requiresOdometerConfirmation).toBe(false);
  });

  it("sin lectura de odómetro y tiempo no vencido → UNKNOWN[ODOMETER_MISSING]", () => {
    const r = run(v1OilInput({ odometer: null }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["ODOMETER_MISSING"]);
    expect(r.suggestedAction).toBe("CONFIRM_ODOMETER");
  });

  it("sin lectura de odómetro pero vencido por tiempo → DUE y pedir km", () => {
    // 2025-10-10 + 12 meses = 2026-10-10: 18 días excedido, dentro de la gracia de 30.
    const r = run(v1OilInput({ odometer: null, lastService: serviceRecord({ performedOn: "2025-10-10" }) }));
    expect(r.status).toBe("DUE");
    expect(r.technical.reachedBy).toBe("TIME");
    expect(r.technical.remaining?.km).toBeNull();
    expect(r.requiresOdometerConfirmation).toBe(true);
  });
});

describe("Maintenance Engine — correa vs cadena (EX-01)", () => {
  it("ME-21 regla de correa en vehículo con cadena → NOT_APPLICABLE", () => {
    const r = run(v2BeltInput({ spec: { engineCode: "DEMO-2.0", timingDrive: "CHAIN", market: "CO" } }));
    expect(r.status).toBe("NOT_APPLICABLE");
    expect(r.technical.status).toBe("NOT_APPLICABLE");
    expect(r.communication).toBeNull();
    expect(r.reasons).toEqual(["NOT_APPLICABLE_TIMING_DRIVE"]);
    expect(r.suggestedAction).toBe("NONE");
  });

  it("ME-22 tipo de distribución desconocido → UNKNOWN[TIMING_DRIVE_UNKNOWN]", () => {
    const r = run(v2BeltInput({ spec: { engineCode: "DEMO-2.0", timingDrive: "UNKNOWN", market: "CO" } }));
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["TIMING_DRIVE_UNKNOWN"]);
    expect(r.suggestedAction).toBe("HUMAN_REVIEW");
  });

  it("ME-23 V2: correa con regla demo validada, 95.000 km y sin constancia → UNKNOWN + revisión humana", () => {
    const r = run(v2BeltInput());
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["INSUFFICIENT_HISTORY"]);
    expect(r.suggestedAction).toBe("HUMAN_REVIEW");
    expect(r.ruleId).toBe("rule-demo-belt");
    expect(r.decisionTrace.map((s) => s.step)).toEqual([
      "validate-input",
      "plan",
      "engine",
      "rule-selection",
      "applicability",
      "consistency",
      "baseline",
    ]);
  });
});

describe("Maintenance Engine — zona horaria America/Bogota", () => {
  // Último servicio 2025-10-29 → límite de tiempo 2026-10-29 (fecha local de Bogotá).
  const input = v1OilInput({
    lastService: serviceRecord({ performedOn: "2025-10-29" }),
    odometer: odometerReading({ valueKm: 71_000, observedAt: "2026-10-28T20:00:00-05:00" }),
  });

  it("ME-19 a las 22:00 de Bogotá (03:00 UTC del día siguiente) todavía no vence", () => {
    const r = run(input, new Date("2026-10-29T03:00:00Z"));
    expect(r.asOf.localDate).toBe("2026-10-28");
    expect(r.asOf.timeZone).toBe("America/Bogota");
    expect(r.technical.remaining?.days).toBe(1);
    expect(r.status).toBe("UPCOMING");
  });

  it("ME-19b a medianoche de Bogotá vence (remaining.days = 0)", () => {
    const r = run(input, new Date("2026-10-29T05:00:00Z"));
    expect(r.asOf.localDate).toBe("2026-10-29");
    expect(r.status).toBe("DUE");
    expect(r.technical.remaining?.days).toBe(0);
  });

  it("ME-17 fin de mes: servicio el 2026-01-31 + 1 mes vence el 2026-02-28", () => {
    const monthly = { ...DEMO_OIL_RULE, intervalKm: null, intervalMonths: 1 };
    const r = run(
      v1OilInput({
        plan: planWith([monthly]),
        lastService: serviceRecord({ performedOn: "2026-01-31" }),
        odometer: odometerReading({ valueKm: 70_100, observedAt: "2026-02-10T09:00:00-05:00" }),
        odometerHistory: [],
      }),
      new Date("2026-02-10T12:00:00-05:00"),
    );
    expect(r.technical.dueBy?.date).toBe("2026-02-28");
  });
});

describe("Maintenance Engine — entrada, trazabilidad y datos sintéticos", () => {
  it("instante sin zona horaria se rechaza (evita depender de la zona del proceso)", () => {
    const r = run(v1OilInput({ odometer: odometerReading({ observedAt: "2026-10-28T09:00:00" }) }));
    expect(r.reasons).toEqual(["INVALID_INPUT"]);
    expect(r.suggestedAction).toBe("HUMAN_REVIEW");
  });

  it("plan sintético sin rótulo SYNTHETIC-DEMO en la fuente → INVALID_INPUT", () => {
    const r = run(v1OilInput({ plan: { ...DEMO_PLAN, sourceRef: "Manual del propietario" } }));
    expect(r.reasons).toEqual(["INVALID_INPUT"]);
  });

  it("plan real con rótulo sintético → INVALID_INPUT", () => {
    const r = run(v1OilInput({ plan: { ...DEMO_PLAN, dataOrigin: "REAL" } }));
    expect(r.reasons).toEqual(["INVALID_INPUT"]);
  });

  it("km negativos o decimales → INVALID_INPUT", () => {
    expect(run(withKm(-1)).reasons).toEqual(["INVALID_INPUT"]);
    expect(run(withKm(74_200.5)).reasons).toEqual(["INVALID_INPUT"]);
  });

  it.each([
    ["policy.leadKm", v1OilInput(), { leadKm: -1 }],
    ["plan.rules[0].intervalKm", v1OilInput({ plan: planWith([{ ...DEMO_OIL_RULE, intervalKm: 0 }]) }), {}],
    ["plan.rules[0].intervalMonths", v1OilInput({ plan: planWith([{ ...DEMO_OIL_RULE, intervalMonths: 1.5 }]) }), {}],
    ["lastService.serviceCode", v1OilInput({ lastService: serviceRecord({ serviceCode: BELT }) }), {}],
    ["lastService.performedOn", v1OilInput({ lastService: serviceRecord({ performedOn: "2026-02-30" }) }), {}],
    ["lastService.odometerKm", v1OilInput({ lastService: serviceRecord({ odometerKm: -5 }) }), {}],
    ["odometerHistory[0].valueKm", v1OilInput({ odometerHistory: [{ valueKm: 1.2, observedAt: "2026-04-01T10:00:00Z" }] }), {}],
    ["odometerHistory[0].observedAt", v1OilInput({ odometerHistory: [{ valueKm: 70_000, observedAt: "ayer" }] }), {}],
  ] as const)("entrada inválida %s → INVALID_INPUT con detalle en la traza", (issue, input, policyOverride) => {
    const r = evaluate(
      input,
      { ...DEMO_POLICIES, communication: { ...DEMO_POLICIES.communication, ...policyOverride } },
      DEMO_NOW,
    );
    expectUnknownWithoutFigures(r);
    expect(r.reasons).toEqual(["INVALID_INPUT"]);
    expect(r.decisionTrace[0]).toEqual({ step: "validate-input", outcome: "INVALID", detail: { issues: [issue] } });
  });

  it("rotula cada fuente sintética usada", () => {
    const r = run(v1OilInput());
    expect(r.dataOrigin.containsSyntheticData).toBe(true);
    expect(r.dataOrigin.syntheticSources).toEqual([
      expect.stringMatching(/^plan:planv-demo-1 \(SYNTHETIC-DEMO:/),
      "serviceRecord:svc-demo-1",
      "odometerReading:odo-demo-1",
      "communicationPolicy:demo-comm-v1",
    ]);
  });

  it("datos reales no se rotulan como sintéticos", () => {
    const r = evaluate(
      v1OilInput({
        plan: { ...DEMO_PLAN, dataOrigin: "REAL", sourceRef: "Plan técnico X rev. 3" },
        lastService: serviceRecord({ dataOrigin: "REAL" }),
        odometer: odometerReading({ dataOrigin: "REAL" }),
      }),
      { ...DEMO_POLICIES, communication: { ...DEMO_POLICIES.communication, dataOrigin: "REAL" } },
      DEMO_NOW,
    );
    expect(r.dataOrigin).toEqual({ containsSyntheticData: false, syntheticSources: [] });
  });

  it("es reproducible: mismo input ⇒ mismo resultado e inputHash; distinto `now` ⇒ distinto hash", () => {
    const a = run(v1OilInput());
    const b = run(v1OilInput());
    expect(a).toEqual(b);
    expect(a.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run(v1OilInput(), new Date("2026-10-29T12:00:00-05:00")).inputHash).not.toBe(a.inputHash);
    expect(a.engineVersion).toBe("1.0.0");
    expect(a.dataQualityPolicyVersion).toBe("demo-dq-v1");
  });

  it("no muta la entrada", () => {
    const input = deepFreeze(v1OilInput());
    expect(() => run(input)).not.toThrow();
  });

  it("`now` inválido es un error de programación", () => {
    expect(() => run(v1OilInput(), new Date("invalid"))).toThrow(RangeError);
  });

  it("el servicio de correa usa su propia regla y no la de aceite", () => {
    const r = run(v2BeltInput({ lastService: serviceRecord({ serviceCode: BELT, odometerKm: 10_000, performedOn: "2021-01-15" }) }));
    expect(r.ruleId).toBe("rule-demo-belt");
    expect(r.technical.dueBy).toEqual({ km: 110_000, date: "2027-01-15" });
    expect(r.serviceCode).not.toBe(OIL);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
