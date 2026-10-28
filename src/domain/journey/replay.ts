import type { ActorRole } from "../policies/access-policy";
import { err, ok, type Result } from "../shared/result";
import { EMPTY_CONTEXT } from "./context";
import type { JourneyEvent } from "./events";
import { transition, type JourneySnapshot } from "./machine";
import { INITIAL_STATE, type JourneyState } from "./states";

export interface RecordedEvent {
  seq: number;
  event: JourneyEvent;
  actorId: string;
  actorRole: ActorRole;
  fromState: JourneyState;
  toState: JourneyState;
}

export type ConsistencyIssue =
  | { kind: "SEQUENCE_GAP"; expected: number; found: number }
  | { kind: "FROM_STATE_MISMATCH"; seq: number; expected: JourneyState; found: JourneyState }
  | { kind: "ILLEGAL_TRANSITION"; seq: number; code: string }
  | { kind: "TO_STATE_MISMATCH"; seq: number; expected: JourneyState; found: JourneyState }
  | { kind: "FINAL_STATE_MISMATCH"; expected: JourneyState; found: JourneyState }
  | { kind: "VERSION_MISMATCH"; expected: number; found: number };

/**
 * Reproduce el historial desde ACTIVATED con la FSM y comprueba que cada evento registrado fue una
 * transición legal y que el estado y la versión persistidos coinciden con el resultado.
 */
export function replayJourney(
  events: readonly RecordedEvent[],
  persisted: { state: JourneyState; version: number },
): Result<JourneySnapshot, ConsistencyIssue[]> {
  const issues: ConsistencyIssue[] = [];
  let snapshot: JourneySnapshot = { state: INITIAL_STATE, context: EMPTY_CONTEXT };
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  ordered.forEach((rec, i) => {
    if (rec.seq !== i + 1) issues.push({ kind: "SEQUENCE_GAP", expected: i + 1, found: rec.seq });
    if (rec.fromState !== snapshot.state) {
      issues.push({ kind: "FROM_STATE_MISMATCH", seq: rec.seq, expected: snapshot.state, found: rec.fromState });
    }
    const outcome = transition(snapshot, rec.event, { actorId: rec.actorId, role: rec.actorRole });
    if (!outcome.ok) {
      issues.push({ kind: "ILLEGAL_TRANSITION", seq: rec.seq, code: outcome.error.code });
      return;
    }
    if (outcome.value.to !== rec.toState) {
      issues.push({ kind: "TO_STATE_MISMATCH", seq: rec.seq, expected: outcome.value.to, found: rec.toState });
    }
    snapshot = { state: outcome.value.to, context: outcome.value.context };
  });

  if (snapshot.state !== persisted.state) {
    issues.push({ kind: "FINAL_STATE_MISMATCH", expected: snapshot.state, found: persisted.state });
  }
  if (ordered.length !== persisted.version) {
    issues.push({ kind: "VERSION_MISMATCH", expected: ordered.length, found: persisted.version });
  }
  return issues.length > 0 ? err(issues) : ok(snapshot);
}
