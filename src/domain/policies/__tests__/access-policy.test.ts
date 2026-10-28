import { describe, expect, it } from "vitest";
import {
  decideCaseResolution,
  decideVehicleAccess,
  MIN_AUDIT_JUSTIFICATION_LENGTH,
  type ActorContext,
  type VehicleAccessFacts,
} from "../access-policy";

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
  portfolioAssignments: [
    { actorId: "adv-1", customerId: "c1", validFrom: new Date("2026-08-01T00:00:00Z"), validTo: null },
    { actorId: "adv-prev", customerId: "c-prev", validFrom: new Date("2025-01-01T00:00:00Z"), validTo: null },
    { actorId: "adv-old", customerId: "c1", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-10-01T00:00:00Z") },
  ],
  openCaseAssigneeIds: ["adv-case", "comp-case"],
};
const onlyOwners = (ownerships: VehicleAccessFacts["ownerships"]): VehicleAccessFacts => ({
  ownerships,
  workshopIdsWithWorkOrders: [],
  portfolioAssignments: [],
  openCaseAssigneeIds: [],
});
const advisor = (actorId: string) => actor({ actorId, role: "ADVISOR", customerId: null });
const compliance = (actorId: string) => actor({ actorId, role: "COMPLIANCE", customerId: null });

describe("access-policy — titular y agente (denegación por defecto)", () => {
  it("permite al titular vigente leer y evaluar", () => {
    expect(decideVehicleAccess(actor({}), "READ_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "ACTIVE_OWNERSHIP" });
    expect(decideVehicleAccess(actor({}), "EVALUATE_VEHICLE", facts, NOW).allowed).toBe(true);
  });

  it("niega a otro cliente y al titular anterior", () => {
    expect(decideVehicleAccess(actor({ customerId: "c2" }), "READ_VEHICLE", facts, NOW)).toEqual({
      allowed: false,
      reason: "UNAUTHORIZED",
      detail: "NO_ACTIVE_OWNERSHIP",
    });
    expect(decideVehicleAccess(actor({ customerId: "c-prev" }), "READ_VEHICLE", facts, NOW).allowed).toBe(false);
  });

  it("la titularidad futura todavía no da acceso y la vencida ya no", () => {
    const future = onlyOwners([{ customerId: "c1", validFrom: new Date("2026-11-01T00:00:00Z"), validTo: null }]);
    expect(decideVehicleAccess(actor({}), "READ_VEHICLE", future, NOW).allowed).toBe(false);
    const endsNow = onlyOwners([{ customerId: "c1", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: NOW }]);
    expect(decideVehicleAccess(actor({}), "READ_VEHICLE", endsNow, NOW).allowed).toBe(false);
  });

  it("OWNER o SYSTEM_AGENT sin cliente → MISSING_IDENTITY; nunca auditan", () => {
    expect(decideVehicleAccess(actor({ customerId: null }), "READ_VEHICLE", facts, NOW)).toMatchObject({ detail: "MISSING_IDENTITY" });
    expect(decideVehicleAccess(actor({ role: "SYSTEM_AGENT", customerId: null }), "READ_VEHICLE", facts, NOW).allowed).toBe(false);
    expect(decideVehicleAccess(actor({}), "AUDIT_READ", facts, NOW, { justification: "x".repeat(40) })).toMatchObject({ detail: "ROLE_NOT_PERMITTED" });
  });

  it("SYSTEM_AGENT solo actúa por un titular vigente", () => {
    expect(decideVehicleAccess(actor({ role: "SYSTEM_AGENT" }), "READ_VEHICLE", facts, NOW).allowed).toBe(true);
    expect(decideVehicleAccess(actor({ role: "SYSTEM_AGENT", customerId: "c2" }), "READ_VEHICLE", facts, NOW).allowed).toBe(false);
  });
});

describe("access-policy — asesor: cartera o caso asignado (ADR-016)", () => {
  it("accede si el titular vigente está en su cartera activa", () => {
    expect(decideVehicleAccess(advisor("adv-1"), "READ_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "PORTFOLIO_ASSIGNMENT" });
    expect(decideVehicleAccess(advisor("adv-1"), "EVALUATE_VEHICLE", facts, NOW).allowed).toBe(true);
  });

  it("no accede por la cartera del titular anterior ni por una asignación vencida", () => {
    expect(decideVehicleAccess(advisor("adv-prev"), "READ_VEHICLE", facts, NOW)).toMatchObject({ allowed: false, detail: "NOT_ASSIGNED" });
    expect(decideVehicleAccess(advisor("adv-old"), "READ_VEHICLE", facts, NOW)).toMatchObject({ allowed: false, detail: "NOT_ASSIGNED" });
  });

  it("accede por un caso abierto asignado; sin asignación, denegado", () => {
    expect(decideVehicleAccess(advisor("adv-case"), "READ_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "CASE_ASSIGNMENT" });
    expect(decideVehicleAccess(advisor("adv-x"), "READ_VEHICLE", facts, NOW)).toMatchObject({ allowed: false, detail: "NOT_ASSIGNED" });
  });

  it("no tiene lectura de auditoría", () => {
    expect(decideVehicleAccess(advisor("adv-1"), "AUDIT_READ", facts, NOW, { justification: "x".repeat(40) }).allowed).toBe(false);
  });
});

describe("access-policy — compliance: solo auditoría justificada o caso asignado (ADR-016)", () => {
  it("sin acceso operativo para leer o evaluar", () => {
    expect(decideVehicleAccess(compliance("comp-1"), "READ_VEHICLE", facts, NOW)).toMatchObject({ allowed: false, detail: "ROLE_NOT_PERMITTED" });
    expect(decideVehicleAccess(compliance("comp-1"), "EVALUATE_VEHICLE", facts, NOW).allowed).toBe(false);
  });

  it("auditoría solo con justificación suficiente", () => {
    expect(decideVehicleAccess(compliance("comp-1"), "AUDIT_READ", facts, NOW)).toMatchObject({ detail: "JUSTIFICATION_REQUIRED" });
    expect(
      decideVehicleAccess(compliance("comp-1"), "AUDIT_READ", facts, NOW, { justification: " ".repeat(30) + "corto" }),
    ).toMatchObject({ detail: "JUSTIFICATION_REQUIRED" });
    expect(
      decideVehicleAccess(compliance("comp-1"), "AUDIT_READ", facts, NOW, { justification: "x".repeat(MIN_AUDIT_JUSTIFICATION_LENGTH) }),
    ).toEqual({ allowed: true, basis: "AUDIT_JUSTIFIED" });
  });

  it("puede leer el vehículo de un caso que tiene asignado, pero no evaluarlo", () => {
    expect(decideVehicleAccess(compliance("comp-case"), "READ_VEHICLE", facts, NOW)).toEqual({ allowed: true, basis: "CASE_ASSIGNMENT" });
    expect(decideVehicleAccess(compliance("comp-case"), "EVALUATE_VEHICLE", facts, NOW).allowed).toBe(false);
  });
});

describe("access-policy — taller y sistema", () => {
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

describe("decideCaseResolution — solo humano autorizado y asignado", () => {
  const open = { status: "ASSIGNED" as const, assigneeId: "adv-1" };

  it("el asesor asignado puede resolver", () => {
    expect(decideCaseResolution(advisor("adv-1"), open)).toEqual({ allowed: true });
    expect(decideCaseResolution(compliance("comp-1"), { ...open, assigneeId: "comp-1" })).toEqual({ allowed: true });
  });

  it("agente, job, propietario o taller nunca resuelven", () => {
    for (const role of ["SYSTEM_AGENT", "SYSTEM_JOB", "OWNER", "WORKSHOP_COORDINATOR", "TECHNICIAN"] as const) {
      expect(decideCaseResolution(actor({ actorId: "adv-1", role }), open)).toMatchObject({ allowed: false, detail: "ROLE_NOT_PERMITTED" });
    }
  });

  it("un humano no asignado, o un caso sin asignar o ya cerrado, se rechaza", () => {
    expect(decideCaseResolution(advisor("adv-2"), open)).toMatchObject({ detail: "NOT_ASSIGNED" });
    expect(decideCaseResolution(advisor("adv-1"), { status: "OPEN", assigneeId: null })).toMatchObject({ detail: "NOT_ASSIGNED" });
    expect(decideCaseResolution(advisor("adv-1"), { ...open, status: "RESOLVED" })).toMatchObject({ detail: "CASE_NOT_OPEN" });
  });
});
