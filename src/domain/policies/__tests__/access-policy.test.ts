import { describe, expect, it } from "vitest";
import { decideVehicleAccess, type ActorContext, type VehicleAccessFacts } from "../access-policy";

const NOW = new Date("2026-10-28T12:00:00-05:00");
const actor = (overrides: Partial<ActorContext>): ActorContext => ({
  actorId: "act-1",
  role: "OWNER",
  customerId: "c1",
  workshopId: null,
  ...overrides,
});
const facts: VehicleAccessFacts = {
  ownerships: [
    { customerId: "c-prev", validFrom: new Date("2025-01-01T00:00:00Z"), validTo: new Date("2026-09-15T00:00:00Z") },
    { customerId: "c1", validFrom: new Date("2026-09-15T00:00:00Z"), validTo: null },
  ],
  workshopIdsWithWorkOrders: ["ws-1"],
};

describe("access-policy (denegación por defecto)", () => {
  it("permite al titular vigente leer y evaluar", () => {
    expect(decideVehicleAccess(actor({}), "READ_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "ACTIVE_OWNERSHIP" });
    expect(decideVehicleAccess(actor({}), "EVALUATE_VEHICLE", facts, NOW).allowed).toBe(true);
  });

  it("niega a otro cliente (IT-04 en versión pura)", () => {
    expect(decideVehicleAccess(actor({ customerId: "c2" }), "READ_VEHICLE", facts, NOW)).toEqual({
      allowed: false,
      reason: "UNAUTHORIZED",
      detail: "NO_ACTIVE_OWNERSHIP",
    });
  });

  it("niega al propietario anterior aunque haya sido titular", () => {
    expect(decideVehicleAccess(actor({ customerId: "c-prev" }), "READ_VEHICLE", facts, NOW).allowed).toBe(false);
  });

  it("la titularidad futura todavía no da acceso y la vencida ya no", () => {
    const future = { ownerships: [{ customerId: "c1", validFrom: new Date("2026-11-01T00:00:00Z"), validTo: null }], workshopIdsWithWorkOrders: [] };
    expect(decideVehicleAccess(actor({}), "READ_VEHICLE", future, NOW).allowed).toBe(false);
    const endsNow = { ownerships: [{ customerId: "c1", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: NOW }], workshopIdsWithWorkOrders: [] };
    expect(decideVehicleAccess(actor({}), "READ_VEHICLE", endsNow, NOW).allowed).toBe(false);
  });

  it("OWNER o SYSTEM_AGENT sin cliente → MISSING_IDENTITY", () => {
    expect(decideVehicleAccess(actor({ customerId: null }), "READ_VEHICLE", facts, NOW)).toMatchObject({ detail: "MISSING_IDENTITY" });
    expect(decideVehicleAccess(actor({ role: "SYSTEM_AGENT", customerId: null }), "READ_VEHICLE", facts, NOW).allowed).toBe(false);
  });

  it("SYSTEM_AGENT solo actúa por un titular vigente", () => {
    expect(decideVehicleAccess(actor({ role: "SYSTEM_AGENT" }), "READ_VEHICLE", facts, NOW).allowed).toBe(true);
    expect(decideVehicleAccess(actor({ role: "SYSTEM_AGENT", customerId: "c2" }), "READ_VEHICLE", facts, NOW).allowed).toBe(false);
  });

  it("asesor y compliance pueden leer y evaluar", () => {
    expect(decideVehicleAccess(actor({ role: "ADVISOR", customerId: null }), "READ_VEHICLE", facts, NOW).allowed).toBe(true);
    expect(decideVehicleAccess(actor({ role: "COMPLIANCE", customerId: null }), "EVALUATE_VEHICLE", facts, NOW).allowed).toBe(true);
  });

  it("taller: solo lectura y solo con orden de trabajo propia", () => {
    const ws = actor({ role: "WORKSHOP_COORDINATOR", customerId: null, workshopId: "ws-1" });
    expect(decideVehicleAccess(ws, "READ_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "WORKSHOP_WORK_ORDER" });
    expect(decideVehicleAccess(ws, "EVALUATE_VEHICLE", facts, NOW)).toMatchObject({ detail: "ROLE_NOT_PERMITTED" });
    expect(decideVehicleAccess({ ...ws, workshopId: "ws-2" }, "READ_VEHICLE", facts, NOW)).toMatchObject({ detail: "NO_WORK_ORDER" });
    expect(decideVehicleAccess({ ...ws, role: "TECHNICIAN", workshopId: null }, "READ_VEHICLE", facts, NOW)).toMatchObject({
      detail: "MISSING_IDENTITY",
    });
  });

  it("job del sistema: evaluar sí, leer perfil no", () => {
    const job = actor({ role: "SYSTEM_JOB", customerId: null });
    expect(decideVehicleAccess(job, "EVALUATE_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "SYSTEM_JOB" });
    expect(decideVehicleAccess(job, "READ_VEHICLE", facts, NOW).allowed).toBe(false);
  });

  it("rol desconocido → denegado", () => {
    const unknown = actor({ role: "HACKER" as unknown as ActorContext["role"] });
    expect(decideVehicleAccess(unknown, "READ_VEHICLE", facts, NOW)).toMatchObject({ allowed: false, detail: "ROLE_NOT_PERMITTED" });
  });
});
