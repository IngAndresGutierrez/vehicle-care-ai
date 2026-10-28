/**
 * Autorización sobre un vehículo (ARCHITECTURE.md §8, AGENT_DESIGN.md §4.1). Pura y con denegación por defecto:
 * solo se permite lo que una regla explícita autoriza. VIN o placa nunca conceden acceso.
 */

export type ActorRole =
  | "OWNER"
  | "ADVISOR"
  | "WORKSHOP_COORDINATOR"
  | "TECHNICIAN"
  | "COMPLIANCE"
  | "SYSTEM_AGENT"
  | "SYSTEM_JOB";

export type VehicleAction = "READ_VEHICLE" | "EVALUATE_VEHICLE";

export interface ActorContext {
  actorId: string;
  role: ActorRole;
  /** OWNER: su cliente. SYSTEM_AGENT: el cliente en cuyo nombre actúa. */
  customerId: string | null;
  /** Roles de taller: su taller. */
  workshopId: string | null;
}

export interface VehicleAccessFacts {
  ownerships: ReadonlyArray<{ customerId: string; validFrom: Date; validTo: Date | null }>;
  /** Talleres con orden de trabajo sobre el vehículo. */
  workshopIdsWithWorkOrders: readonly string[];
}

export type AccessDecision =
  | { allowed: true; basis: AccessBasis }
  | { allowed: false; reason: "UNAUTHORIZED"; detail: DenyDetail };

export type AccessBasis = "ACTIVE_OWNERSHIP" | "STAFF_ROLE" | "WORKSHOP_WORK_ORDER" | "SYSTEM_JOB";
export type DenyDetail = "NO_ACTIVE_OWNERSHIP" | "MISSING_IDENTITY" | "ROLE_NOT_PERMITTED" | "NO_WORK_ORDER";

const deny = (detail: DenyDetail): AccessDecision => ({ allowed: false, reason: "UNAUTHORIZED", detail });

export function isOwnershipActive(o: { validFrom: Date; validTo: Date | null }, now: Date): boolean {
  return o.validFrom.getTime() <= now.getTime() && (o.validTo === null || o.validTo.getTime() > now.getTime());
}

export function decideVehicleAccess(
  actor: ActorContext,
  action: VehicleAction,
  facts: VehicleAccessFacts,
  now: Date,
): AccessDecision {
  switch (actor.role) {
    case "OWNER":
    case "SYSTEM_AGENT": {
      if (!actor.customerId) return deny("MISSING_IDENTITY");
      const owns = facts.ownerships.some((o) => o.customerId === actor.customerId && isOwnershipActive(o, now));
      return owns ? { allowed: true, basis: "ACTIVE_OWNERSHIP" } : deny("NO_ACTIVE_OWNERSHIP");
    }
    case "ADVISOR":
    case "COMPLIANCE":
      return { allowed: true, basis: "STAFF_ROLE" };
    case "WORKSHOP_COORDINATOR":
    case "TECHNICIAN": {
      if (action !== "READ_VEHICLE") return deny("ROLE_NOT_PERMITTED");
      if (!actor.workshopId) return deny("MISSING_IDENTITY");
      return facts.workshopIdsWithWorkOrders.includes(actor.workshopId)
        ? { allowed: true, basis: "WORKSHOP_WORK_ORDER" }
        : deny("NO_WORK_ORDER");
    }
    case "SYSTEM_JOB":
      return action === "EVALUATE_VEHICLE" ? { allowed: true, basis: "SYSTEM_JOB" } : deny("ROLE_NOT_PERMITTED");
    default:
      return deny("ROLE_NOT_PERMITTED");
  }
}
