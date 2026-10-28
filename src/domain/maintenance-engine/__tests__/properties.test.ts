import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate } from "../evaluate";
import type { CommunicationPolicy, DueStatus } from "../types";
import {
  DEMO_NOW,
  DEMO_PLAN,
  DEMO_POLICIES,
  odometerReading,
  serviceRecord,
  v1OilInput,
} from "../__fixtures__/synthetic-demo";

const RANK: Partial<Record<DueStatus, number>> = { NOT_DUE: 0, UPCOMING: 1, DUE: 2, OVERDUE: 3 };
const DAY_MS = 86_400_000;

/** Lectura fresca (tomada en `now`) para que la dimensión KM sea siempre concluyente. */
const freshInput = (valueKm: number, now: Date) =>
  v1OilInput({ odometer: odometerReading({ valueKm, observedAt: now.toISOString() }) });

const policyArb: fc.Arbitrary<CommunicationPolicy> = fc.record({
  policyVersion: fc.constant("prop"),
  dataOrigin: fc.constant("SYNTHETIC" as const),
  leadKm: fc.integer({ min: 0, max: 5_000 }),
  leadDays: fc.integer({ min: 0, max: 120 }),
  overdueGraceKm: fc.integer({ min: 0, max: 5_000 }),
  overdueGraceDays: fc.integer({ min: 0, max: 120 }),
});

describe("Maintenance Engine — propiedades", () => {
  it("ME-P1 determinismo: misma entrada ⇒ mismo resultado e inputHash", () => {
    fc.assert(
      fc.property(fc.integer({ min: 70_000, max: 90_000 }), (km) => {
        const a = evaluate(freshInput(km, DEMO_NOW), DEMO_POLICIES, DEMO_NOW);
        const b = evaluate(freshInput(km, DEMO_NOW), DEMO_POLICIES, DEMO_NOW);
        expect(a).toEqual(b);
      }),
    );
  });

  it("ME-P2a monotonicidad en km: más kilometraje nunca mejora el estado", () => {
    fc.assert(
      fc.property(fc.integer({ min: 70_000, max: 90_000 }), fc.integer({ min: 0, max: 10_000 }), (km, extra) => {
        const lower = evaluate(freshInput(km, DEMO_NOW), DEMO_POLICIES, DEMO_NOW);
        const higher = evaluate(freshInput(km + extra, DEMO_NOW), DEMO_POLICIES, DEMO_NOW);
        expect(RANK[higher.status]!).toBeGreaterThanOrEqual(RANK[lower.status]!);
      }),
    );
  });

  it("ME-P2b monotonicidad en tiempo: más días transcurridos nunca mejoran el estado", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 0, max: 200 }), (d1, extra) => {
        const t1 = new Date(Date.parse("2026-04-02T12:00:00-05:00") + d1 * DAY_MS);
        const t2 = new Date(t1.getTime() + extra * DAY_MS);
        const earlier = evaluate(freshInput(71_000, t1), DEMO_POLICIES, t1);
        const later = evaluate(freshInput(71_000, t2), DEMO_POLICIES, t2);
        expect(RANK[later.status]!).toBeGreaterThanOrEqual(RANK[earlier.status]!);
      }),
    );
  });

  it("ME-P3 UNKNOWN ⇒ sin cifras de vencimiento", () => {
    const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null });
    fc.assert(
      fc.property(
        maybe(fc.constantFrom(DEMO_PLAN, { ...DEMO_PLAN, status: "DRAFT" as const })),
        maybe(fc.constantFrom("DEMO-1.6")),
        maybe(fc.integer({ min: 0, max: 120_000 }).map((km) => serviceRecord({ odometerKm: km }))),
        maybe(fc.integer({ min: 0, max: 120_000 }).map((km) => odometerReading({ valueKm: km }))),
        fc.constantFrom("ENGINE_OIL_FILTER", "TIMING_BELT", "UNKNOWN_SERVICE"),
        (plan, engineCode, lastService, odometer, serviceCode) => {
          const r = evaluate(
            v1OilInput({
              plan,
              spec: { engineCode, timingDrive: "CHAIN", market: "CO" },
              serviceCode,
              lastService: lastService && { ...lastService, serviceCode },
              odometer,
              odometerHistory: [],
            }),
            DEMO_POLICIES,
            DEMO_NOW,
          );
          if (r.status === "UNKNOWN") {
            expect(r.technical.dueBy).toBeNull();
            expect(r.technical.remaining).toBeNull();
            expect(r.communication).toBeNull();
            expect(r.suggestedAction === "HUMAN_REVIEW" || r.suggestedAction === "CONFIRM_ODOMETER").toBe(true);
          }
        },
      ),
    );
  });

  it("ME-P4 la política de comunicación nunca cambia el vencimiento técnico (ADR-012)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 70_000, max: 90_000 }),
        fc.integer({ min: -400, max: 400 }),
        policyArb,
        (km, dayOffset, communication) => {
          const now = new Date(DEMO_NOW.getTime() + dayOffset * DAY_MS);
          const input = v1OilInput({
            lastService: serviceRecord({ performedOn: "2026-04-01" }),
            odometer: odometerReading({ valueKm: km, observedAt: now.toISOString() }),
            odometerHistory: [],
          });
          const baseline = evaluate(input, DEMO_POLICIES, now);
          const other = evaluate(input, { ...DEMO_POLICIES, communication }, now);
          expect(other.technical).toEqual(baseline.technical);
          if (other.technical.status === "DUE") expect(["DUE", "OVERDUE"]).toContain(other.status);
          if (other.technical.status === "NOT_DUE") expect(["NOT_DUE", "UPCOMING"]).toContain(other.status);
        },
      ),
    );
  });
});
