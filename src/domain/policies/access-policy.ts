/**
 * Autorización sobre un vehículo (ARCHITECTURE.md §8, AGENT_DESIGN.md §4.1, ADR-016). Pura, con mínimo
 * privilegio y denegación por defecto: solo se permite lo que una regla explícita autoriza.
 * VIN o placa nunca conceden acceso.
 */

export type ActorRole =
  | "OWNER"
  | "ADVISOR"
  | "WORKSHOP_COORDINATOR"
  | "TECHNICIAN"
  | "COMPLIANCE"
  | "SYSTEM_AGENT"
  | "SYSTEM_JOB";

/**
 * READ_VEHICLE / EVALUATE_VEHICLE: operación diaria.
 * AUDIT_READ: lectura de trazas por compliance; exige justificación, que la aplicación registra en AuditLog.
 */
export type VehicleAction = "READ_VEHICLE" | "EVALUATE_VEHICLE" | "AUDIT_READ";

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
  /** Talleres con orden de trabajo o servicio sobre el vehículo. */
  workshopIdsWithWorkOrders: readonly string[];
  /** Asignaciones de cartera (asesor ↔ cliente) de los clientes relacionados con el vehículo. */
  portfolioAssignments: ReadonlyArray<{ actorId: string; customerId: string; validFrom: Date; validTo: Date | null }>;
  /** Casos abiertos del vehículo con su responsable asignado. */
  openCaseAssigneeIds: readonly string[];
}

export type AccessDecision =
  | { allowed: true; basis: AccessBasis }
  | { allowed: false; reason: "UNAUTHORIZED"; detail: DenyDetail };

export type AccessBasis =
  | "ACTIVE_OWNERSHIP"
  | "PORTFOLIO_ASSIGNMENT"
  | "CASE_ASSIGNMENT"
  | "AUDIT_JUSTIFIED"
  | "WORKSHOP_WORK_ORDER"
  | "SYSTEM_JOB";

export type DenyDetail =
  | "NO_ACTIVE_OWNERSHIP"
  | "MISSING_IDENTITY"
  | "ROLE_NOT_PERMITTED"
  | "NO_WORK_ORDER"
  | "NOT_ASSIGNED"
  | "JUSTIFICATION_REQUIRED";

/** Longitud mínima de una justificación de auditoría (evita textos vacíos o de relleno). */
export const MIN_AUDIT_JUSTIFICATION_LENGTH = 15;

const deny = (detail: DenyDetail): AccessDecision => ({ allowed: false, reason: "UNAUTHORIZED", detail });

export function isOwnershipActive(o: { validFrom: Date; validTo: Date | null }, now: Date): boolean {
  return o.validFrom.getTime() <= now.getTime() && (o.validTo === null || o.validTo.getTime() > now.getTime());
}

function activeOwnerIds(facts: VehicleAccessFacts, now: Date): Set<string> {
  return new Set(facts.ownerships.filter((o) => isOwnershipActive(o, now)).map((o) => o.customerId));
}

export function decideVehicleAccess(
  actor: ActorContext,
  action: VehicleAction,
  facts: VehicleAccessFacts,
  now: Date,
  options: { justification?: string } = {},
): AccessDecision {
  switch (actor.role) {
    case "OWNER":
    case "SYSTEM_AGENT": {
      if (action === "AUDIT_READ") return deny("ROLE_NOT_PERMITTED");
      if (!actor.customerId) return deny("MISSING_IDENTITY");
      return activeOwnerIds(facts, now).has(actor.customerId)
        ? { allowed: true, basis: "ACTIVE_OWNERSHIP" }
        : deny("NO_ACTIVE_OWNERSHIP");
    }
    case "ADVISOR": {
      if (action === "AUDIT_READ") return deny("ROLE_NOT_PERMITTED");
      // Solo la cartera del titular vigente (no la de titulares anteriores) o un caso asignado.
      const owners = activeOwnerIds(facts, now);
      const inPortfolio = facts.portfolioAssignments.some(
        (a) => a.actorId === actor.actorId && owners.has(a.customerId) && isOwnershipActive(a, now),
      );
      if (inPortfolio) return { allowed: true, basis: "PORTFOLIO_ASSIGNMENT" };
      if (facts.openCaseAssigneeIds.includes(actor.actorId)) return { allowed: true, basis: "CASE_ASSIGNMENT" };
      return deny("NOT_ASSIGNED");
    }
    case "COMPLIANCE": {
      // Sin acceso operativo: lee para auditar con justificación, o un caso que tenga asignado.
      if (action === "AUDIT_READ") {
        return (options.justification?.trim().length ?? 0) >= MIN_AUDIT_JUSTIFICATION_LENGTH
          ? { allowed: true, basis: "AUDIT_JUSTIFIED" }
          : deny("JUSTIFICATION_REQUIRED");
      }
      if (action === "READ_VEHICLE" && facts.openCaseAssigneeIds.includes(actor.actorId)) {
        return { allowed: true, basis: "CASE_ASSIGNMENT" };
      }
      return deny("ROLE_NOT_PERMITTED");
    }
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

export interface CaseFacts {
  status: "OPEN" | "ASSIGNED" | "RESOLVED" | "CLOSED";
  assigneeId: string | null;
}

export type CaseResolutionDecision =
  | { allowed: true }
  | { allowed: false; reason: "UNAUTHORIZED"; detail: "ROLE_NOT_PERMITTED" | "NOT_ASSIGNED" | "CASE_NOT_OPEN" };

/**
 * Solo un humano de rol autorizado (ADVISOR o COMPLIANCE) **asignado** al caso puede resolverlo.
 * Un caso sin asignar debe asignarse primero (operación de supervisión, Fase 6).
 */
export function decideCaseResolution(actor: ActorContext, kase: CaseFacts): CaseResolutionDecision {
  if (actor.role !== "ADVISOR" && actor.role !== "COMPLIANCE") {
    return { allowed: false, reason: "UNAUTHORIZED", detail: "ROLE_NOT_PERMITTED" };
  }
  if (kase.status !== "OPEN" && kase.status !== "ASSIGNED") {
    return { allowed: false, reason: "UNAUTHORIZED", detail: "CASE_NOT_OPEN" };
  }
  return kase.assigneeId === actor.actorId
    ? { allowed: true }
    : { allowed: false, reason: "UNAUTHORIZED", detail: "NOT_ASSIGNED" };
}
