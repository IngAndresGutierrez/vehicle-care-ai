import type { JourneyEvent } from "./events";
import { transition, type JourneyActor, type JourneySnapshot } from "./machine";

/**
 * Una re-evaluación es redundante si la FSM no cambia de estado y el resultado (estado del motor y ciclo)
 * ya es el registrado. Evita que cada ejecución del job agregue eventos idénticos al historial.
 */
export function isRedundantEvaluation(
  snapshot: JourneySnapshot,
  event: Extract<JourneyEvent, { type: "EVALUATED" }>,
  actor: JourneyActor,
): boolean {
  const outcome = transition(snapshot, event, actor);
  if (!outcome.ok || outcome.value.to !== snapshot.state) return false;
  const last = snapshot.context.lastEvaluation;
  return last !== null && last.status === event.status && last.cycleKey === event.cycleKey;
}
