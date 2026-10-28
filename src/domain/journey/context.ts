import type { DueStatus } from "../maintenance-engine/types";

/**
 * Contexto mínimo que la FSM necesita para sus guardias. Se persiste junto al estado en la misma
 * transacción, de modo que estado y contexto nunca divergen.
 */
export interface JourneyContext {
  lastEvaluation: { evaluationId: string; status: DueStatus; cycleKey: string | null } | null;
  activeQuoteId: string | null;
  pendingIntentId: string | null;
  activeBookingId: string | null;
  openCaseId: string | null;
  openCaseReason: string | null;
}

export const EMPTY_CONTEXT: JourneyContext = {
  lastEvaluation: null,
  activeQuoteId: null,
  pendingIntentId: null,
  activeBookingId: null,
  openCaseId: null,
  openCaseReason: null,
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Lee un contexto persistido (JSON) tolerando campos ausentes; nunca inventa valores. */
export function parseContext(raw: unknown): JourneyContext {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const le = o.lastEvaluation as Record<string, unknown> | null | undefined;
  return {
    lastEvaluation:
      le && typeof le === "object" && typeof le.evaluationId === "string" && typeof le.status === "string"
        ? { evaluationId: le.evaluationId, status: le.status as DueStatus, cycleKey: str(le.cycleKey) }
        : null,
    activeQuoteId: str(o.activeQuoteId),
    pendingIntentId: str(o.pendingIntentId),
    activeBookingId: str(o.activeBookingId),
    openCaseId: str(o.openCaseId),
    openCaseReason: str(o.openCaseReason),
  };
}
