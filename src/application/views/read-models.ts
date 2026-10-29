import { allowedTools, replayJourney, type CaseResolutionOutcome, type JourneyEvent, type JourneyState } from "@/domain/journey";
import { decideCaseResolution, decideVehicleAccess, isOwnershipActive, type ActorContext } from "@/domain/policies/access-policy";
import { err, ok, type Result } from "@/domain/shared/result";
import type { Clock } from "@/infra/clock";
import type { Db } from "@/infra/prisma";
import { audit } from "../booking/common";
import { appError, type AppError } from "../errors";
import { getMaintenancePlan, type MaintenancePlanView } from "../get-maintenance-plan";
import { getServiceHistory, type ServiceHistory } from "../get-service-history";
import { getVehicleProfile, maskPlate, type VehicleProfile } from "../get-vehicle-profile";
import { findJourney } from "../journey/journey-store";
import { loadVehicleAccessFacts } from "../vehicle-access";

/**
 * Modelos de lectura para la UI (Fase 6, PHASE6_HANDOFF §4). Solo leen; aplican la misma política de acceso que
 * los casos de uso y nunca devuelven tokens ni datos personales del propietario.
 */
type Deps = { db: Db; clock: Clock };

const PAUSED_STATES: ReadonlySet<JourneyState> = new Set(["SAFETY_ESCALATED", "HUMAN_REVIEW", "QUOTE_PENDING_HUMAN"]);

// ───────────────────────────── Mi sesión ─────────────────────────────

export interface MeView {
  actorId: string;
  role: ActorContext["role"];
  displayName: string;
  isDemo: boolean;
  vehicles: Array<{ vehicleId: string; alias: string; plateMasked: string | null; dataOrigin: string }>;
}

export async function getMe({ db, clock }: Deps, actor: ActorContext): Promise<MeView> {
  const now = clock.now();
  const account = await db.actorAccount.findUniqueOrThrow({ where: { id: actor.actorId } });
  let customerIds: string[] = [];
  if (actor.role === "OWNER" && actor.customerId) customerIds = [actor.customerId];
  if (actor.role === "ADVISOR") {
    const assignments = await db.portfolioAssignment.findMany({ where: { actorId: actor.actorId } });
    customerIds = assignments.filter((a) => isOwnershipActive(a, now)).map((a) => a.customerId);
  }
  const ownerships = customerIds.length
    ? await db.vehicleOwnership.findMany({ where: { customerId: { in: customerIds } }, include: { vehicle: { include: { spec: true } } }, orderBy: { validFrom: "desc" } })
    : [];
  return {
    actorId: account.id,
    role: account.role,
    displayName: account.displayName,
    isDemo: account.isDemo,
    vehicles: ownerships
      .filter((o) => isOwnershipActive(o, now))
      .slice(0, 50)
      .map((o) => ({ vehicleId: o.vehicleId, alias: `${o.vehicle.spec.model} ${o.vehicle.spec.modelYear}`, plateMasked: o.vehicle.plate ? maskPlate(o.vehicle.plate) : null, dataOrigin: o.vehicle.dataOrigin })),
  };
}

// ───────────────────────────── Portal del vehículo ─────────────────────────────

export interface VehicleOverview {
  profile: VehicleProfile;
  history: ServiceHistory;
  plan: MaintenancePlanView | null;
  planError: string | null;
  serviceCode: string;
  evaluation: null | {
    evaluationId: string;
    status: string;
    technicalStatus: string;
    communicationStatus: string | null;
    reasons: string[];
    dueByKm: number | null;
    dueByDate: string | null;
    remainingKm: number | null;
    remainingDays: number | null;
    suggestedAction: string;
    requiresOdometerConfirmation: boolean;
    planVersion: string | null;
    sourceRef: string | null;
    engineVersion: string;
    evaluatedAt: string;
    baselineServiceRecordId: string | null;
    containsSyntheticData: boolean;
  };
  journey: { state: JourneyState; allowedTools: readonly string[]; agentPaused: boolean };
  booking: null | { bookingId: string; status: string; folio: string | null; startsAt: string; workshopName: string; totalCop: number | null; source: string; failureCode: string | null };
  pendingIntent: null | { intentId: string; expiresAt: string };
  openCases: Array<{ caseId: string; reason: string; priority: string; status: string }>;
}

export async function getVehicleOverview(deps: Deps, { actor, vehicleId, serviceCode }: { actor: ActorContext; vehicleId: string; serviceCode: string }): Promise<Result<VehicleOverview, AppError>> {
  const profile = await getVehicleProfile(deps, { actor, vehicleId });
  if (!profile.ok) return profile;
  const history = await getServiceHistory(deps, { actor, vehicleId });
  if (!history.ok) return history;
  const plan = await getMaintenancePlan(deps, { actor, vehicleId });

  const [evaluation, journey, booking, intent, cases] = await Promise.all([
    deps.db.maintenanceEvaluation.findFirst({ where: { vehicleId, serviceCode }, orderBy: { evaluatedAt: "desc" } }),
    findJourney(deps.db, { vehicleId, serviceCode }),
    deps.db.booking.findFirst({ where: { vehicleId, serviceCode }, orderBy: { createdAt: "desc" }, include: { quote: true } }),
    deps.db.bookingIntent.findFirst({ where: { vehicleId, serviceCode, status: "AWAITING_USER", expiresAt: { gt: deps.clock.now() } }, orderBy: { createdAt: "desc" } }),
    deps.db.humanCase.findMany({ where: { vehicleId, status: { in: ["OPEN", "ASSIGNED"] } }, orderBy: { createdAt: "desc" } }),
  ]);
  const state: JourneyState = journey?.state ?? "ACTIVATED";
  const workshop = booking ? await deps.db.workshop.findUnique({ where: { id: booking.workshopId } }) : null;

  return ok({
    profile: profile.value,
    history: history.value,
    plan: plan.ok ? plan.value : null,
    planError: plan.ok ? null : plan.error.code,
    serviceCode,
    evaluation: evaluation && {
      evaluationId: evaluation.id,
      status: evaluation.status,
      technicalStatus: evaluation.technicalStatus,
      communicationStatus: evaluation.communicationStatus,
      reasons: evaluation.reasons,
      dueByKm: evaluation.dueByKm,
      dueByDate: evaluation.dueByDate?.toISOString().slice(0, 10) ?? null,
      remainingKm: evaluation.remainingKm,
      remainingDays: evaluation.remainingDays,
      suggestedAction: evaluation.suggestedAction,
      requiresOdometerConfirmation: evaluation.requiresOdometerConfirmation,
      planVersion: evaluation.planVersionLabel,
      sourceRef: evaluation.planSourceRef,
      engineVersion: evaluation.engineVersion,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
      baselineServiceRecordId: evaluation.baselineServiceRecordId,
      containsSyntheticData: evaluation.containsSyntheticData,
    },
    journey: { state, allowedTools: allowedTools(state), agentPaused: PAUSED_STATES.has(state) },
    booking: booking && {
      bookingId: booking.id,
      status: booking.status,
      folio: booking.status === "CONFIRMED" ? booking.externalBookingRef : null,
      startsAt: booking.startsAt.toISOString(),
      workshopName: workshop?.name ?? booking.workshopId,
      totalCop: booking.quote.totalCop,
      source: booking.source,
      failureCode: booking.failureCode,
    },
    pendingIntent: intent && { intentId: intent.id, expiresAt: intent.expiresAt.toISOString() },
    openCases: cases.map((c) => ({ caseId: c.id, reason: c.reason, priority: c.priority, status: c.status })),
  });
}

// ───────────────────────────── Panel de trazabilidad ─────────────────────────────

const SAFE_EVENT_KEYS = new Set(["evaluationId", "status", "reasons", "requiresOdometerConfirmation", "quoteId", "workshopId", "intentId", "bookingId", "externalBookingRef", "caseId", "reason", "outcome", "code", "source", "readingId", "workOrderId", "serviceRecordId", "outboundMessageId"]);

const ACTOR_LABEL: Record<string, string> = {
  OWNER: "Propietario",
  SYSTEM_AGENT: "Asistente (agente)",
  SYSTEM_JOB: "Sistema",
  ADVISOR: "Asesor",
  COMPLIANCE: "Compliance",
  WORKSHOP_COORDINATOR: "Taller",
  TECHNICIAN: "Taller",
};

export interface TraceView {
  vehicle: { vehicleId: string; alias: string; plateMasked: string | null };
  serviceCode: string;
  journey: { state: JourneyState; version: number; consistent: boolean; issues: string[]; agentPaused: boolean };
  events: Array<{ seq: number; type: string; fromState: string; toState: string; actorRole: string; actorLabel: string; occurredAt: string; traceId: string; details: Record<string, unknown> }>;
  toolCalls: Array<{ traceId: string; tool: string; ok: boolean; errorCode: string | null; source: string; durationMs: number; stateAtCall: string | null; summary: string; input: unknown; createdAt: string }>;
  evaluations: Array<{ evaluationId: string; status: string; technicalStatus: string; reasons: string[]; planVersion: string | null; sourceRef: string | null; engineVersion: string; inputHash: string; evaluatedAt: string; decisionTrace: Array<{ step: string; outcome: string }> }>;
  guardFlags: Array<{ createdAt: string; role: string; flags: string[]; traceId: string }>;
  access: { basis: string };
}

export async function getTraceView(
  deps: Deps,
  { actor, vehicleId, serviceCode, justification }: { actor: ActorContext; vehicleId: string; serviceCode: string; justification?: string },
): Promise<Result<TraceView, AppError>> {
  const now = deps.clock.now();
  const facts = await loadVehicleAccessFacts(deps.db, vehicleId);
  if (!facts) return err(appError("UNAUTHORIZED", "NO_ACTIVE_OWNERSHIP"));
  const action = actor.role === "COMPLIANCE" ? "AUDIT_READ" : "READ_VEHICLE";
  const decision = decideVehicleAccess(actor, action, facts, now, { justification });
  if (!decision.allowed) return err(appError("UNAUTHORIZED", decision.detail));
  if (action === "AUDIT_READ") {
    await audit(deps.db, { actor: { actorId: actor.actorId, role: actor.role }, action: "AUDIT_READ", entityType: "Vehicle", entityId: vehicleId, details: { serviceCode, justification: justification!.slice(0, 500) }, traceId: "audit", at: now });
  }

  const vehicle = await deps.db.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { spec: true } });
  const journey = await deps.db.journeyInstance.findFirst({ where: { vehicleId, serviceCode }, include: { events: { orderBy: { seq: "asc" } } } });
  const sessions = await deps.db.conversationSession.findMany({ where: { vehicleId, serviceCode }, select: { id: true } });
  const sessionIds = sessions.map((s) => s.id);
  const [toolCalls, evaluations, messages] = await Promise.all([
    deps.db.toolCall.findMany({ where: { sessionId: { in: sessionIds } }, orderBy: { createdAt: "asc" }, take: 200 }),
    deps.db.maintenanceEvaluation.findMany({ where: { vehicleId, serviceCode }, orderBy: { evaluatedAt: "desc" }, take: 5 }),
    deps.db.conversationMessage.findMany({ where: { sessionId: { in: sessionIds }, NOT: { flagged: { isEmpty: true } } }, orderBy: { createdAt: "asc" }, select: { createdAt: true, role: true, flagged: true, traceId: true } }),
  ]);

  let consistent = true;
  let issues: string[] = [];
  if (journey) {
    const replay = replayJourney(
      journey.events.map((e) => ({ seq: e.seq, event: { type: e.type, ...(e.payload as object) } as JourneyEvent, actorId: e.actorId, actorRole: e.actorRole, fromState: e.fromState as JourneyState, toState: e.toState as JourneyState })),
      { state: journey.state as JourneyState, version: journey.version },
    );
    consistent = replay.ok;
    issues = replay.ok ? [] : replay.error.map((i) => i.kind);
  }

  return ok({
    vehicle: { vehicleId, alias: `${vehicle.spec.model} ${vehicle.spec.modelYear}`, plateMasked: vehicle.plate ? maskPlate(vehicle.plate) : null },
    serviceCode,
    journey: { state: (journey?.state as JourneyState) ?? "ACTIVATED", version: journey?.version ?? 0, consistent, issues, agentPaused: PAUSED_STATES.has((journey?.state as JourneyState) ?? "ACTIVATED") },
    events: (journey?.events ?? []).map((e) => ({
      seq: e.seq,
      type: e.type,
      fromState: e.fromState,
      toState: e.toState,
      actorRole: e.actorRole,
      actorLabel: ACTOR_LABEL[e.actorRole] ?? e.actorRole,
      occurredAt: e.occurredAt.toISOString(),
      traceId: e.traceId,
      details: Object.fromEntries(Object.entries((e.payload as Record<string, unknown>) ?? {}).filter(([k]) => SAFE_EVENT_KEYS.has(k))),
    })),
    toolCalls: toolCalls.map((c) => ({
      traceId: c.traceId,
      tool: c.toolName,
      ok: c.ok,
      errorCode: c.errorCode,
      source: c.source,
      durationMs: c.durationMs,
      stateAtCall: c.stateAtCall,
      summary: ((c.outputSummary as { summary?: string } | null)?.summary ?? "").slice(0, 200),
      input: c.inputRedacted,
      createdAt: c.createdAt.toISOString(),
    })),
    evaluations: evaluations.map((e) => ({
      evaluationId: e.id,
      status: e.status,
      technicalStatus: e.technicalStatus,
      reasons: e.reasons,
      planVersion: e.planVersionLabel,
      sourceRef: e.planSourceRef,
      engineVersion: e.engineVersion,
      inputHash: e.inputHash.slice(0, 12),
      evaluatedAt: e.evaluatedAt.toISOString(),
      decisionTrace: ((e.decisionTrace as Array<{ step: string; outcome: string }>) ?? []).map(({ step, outcome }) => ({ step, outcome })),
    })),
    guardFlags: messages.map((m) => ({ createdAt: m.createdAt.toISOString(), role: m.role, flags: m.flagged, traceId: m.traceId })),
    access: { basis: decision.basis },
  });
}

// ───────────────────────────── Bandeja de atención humana ─────────────────────────────

const OUTCOMES_BY_STATE: Partial<Record<JourneyState, CaseResolutionOutcome[]>> = {
  SAFETY_ESCALATED: ["CLEARED_FOR_SERVICE", "CLOSE"],
  HUMAN_REVIEW: ["REEVALUATE", "CLOSE"],
  QUOTE_PENDING_HUMAN: ["CLOSE"],
};

export interface CaseView {
  caseId: string;
  reason: string;
  priority: string;
  status: string;
  createdAt: string;
  slaDueAt: string;
  slaBreached: boolean;
  resolvedAt: string | null;
  resolution: string | null;
  assignee: { actorId: string | null; isMe: boolean; role: string };
  openedByRole: string;
  /** Resumen mínimo escrito por el propietario o el agente: dato no confiable, se muestra como texto plano. */
  summary: string | null;
  vehicle: { vehicleId: string; alias: string; plateMasked: string | null; serviceCode: string | null };
  journey: { state: JourneyState | null; agentPaused: boolean };
  canResolve: boolean;
  resolveBlockedReason: string | null;
  allowedOutcomes: CaseResolutionOutcome[];
}

export async function getCasesInbox({ db, clock }: Deps, actor: ActorContext): Promise<Result<CaseView[], AppError>> {
  if (actor.role !== "ADVISOR" && actor.role !== "COMPLIANCE") return err(appError("UNAUTHORIZED", "ROLE_NOT_PERMITTED"));
  const now = clock.now();
  const assignments = actor.role === "ADVISOR" ? await db.portfolioAssignment.findMany({ where: { actorId: actor.actorId } }) : [];
  const portfolio = assignments.filter((a) => isOwnershipActive(a, now)).map((a) => a.customerId);

  const cases = await db.humanCase.findMany({
    where: {
      OR: [
        { assigneeId: actor.actorId },
        // Casos sin asignar de la cartera: visibles, pero solo un supervisor puede asignarlos (D-34).
        ...(portfolio.length ? [{ assigneeId: null, vehicle: { ownerships: { some: { customerId: { in: portfolio }, validTo: null } } } }] : []),
      ],
    },
    include: { vehicle: { include: { spec: true } }, journey: true },
    orderBy: [{ createdAt: "desc" }],
    take: 100,
  });

  const openers = await db.actorAccount.findMany({ where: { id: { in: [...new Set(cases.map((c) => c.openedById))] } }, select: { id: true, role: true } });
  const openerRole = new Map(openers.map((o) => [o.id, o.role as string]));
  const rank: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  return ok(
    cases
      .map((c) => {
        const decision = decideCaseResolution(actor, { status: c.status, assigneeId: c.assigneeId });
        const state = (c.journey?.state as JourneyState | undefined) ?? null;
        const outcomes = state ? (OUTCOMES_BY_STATE[state] ?? []) : [];
        const open = c.status === "OPEN" || c.status === "ASSIGNED";
        return {
          caseId: c.id,
          reason: c.reason,
          priority: c.priority,
          status: c.status,
          createdAt: c.createdAt.toISOString(),
          slaDueAt: c.slaDueAt.toISOString(),
          slaBreached: open && c.slaDueAt.getTime() < now.getTime(),
          resolvedAt: c.resolvedAt?.toISOString() ?? null,
          resolution: c.resolution,
          assignee: { actorId: c.assigneeId, isMe: c.assigneeId === actor.actorId, role: c.assigneeRole },
          openedByRole: openerRole.get(c.openedById) ?? (c.openedById.startsWith("agent:") ? "SYSTEM_AGENT" : c.openedById.startsWith("system:") ? "SYSTEM_JOB" : "UNKNOWN"),
          summary: typeof (c.minimalContext as { summary?: unknown })?.summary === "string" ? String((c.minimalContext as { summary: string }).summary).slice(0, 300) : null,
          vehicle: { vehicleId: c.vehicleId, alias: `${c.vehicle.spec.model} ${c.vehicle.spec.modelYear}`, plateMasked: c.vehicle.plate ? maskPlate(c.vehicle.plate) : null, serviceCode: c.journey?.serviceCode ?? null },
          journey: { state, agentPaused: state ? PAUSED_STATES.has(state) : false },
          canResolve: decision.allowed && outcomes.length > 0,
          resolveBlockedReason: !open ? "CASE_NOT_OPEN" : !decision.allowed ? decision.detail : outcomes.length === 0 ? "JOURNEY_STATE" : null,
          allowedOutcomes: decision.allowed ? outcomes : [],
        };
      })
      .sort((a, b) => Number(b.status === "OPEN" || b.status === "ASSIGNED") - Number(a.status === "OPEN" || a.status === "ASSIGNED") || rank[a.priority] - rank[b.priority]),
  );
}

