# Traspaso a la Fase 6 (UI) — endpoints, tarjetas y datos

**Fecha:** 2026-10-28 · Base: Fase 5 (ADR-018). Este documento enumera lo que la UI puede consumir hoy y lo que aún falta construir. **No implementa la Fase 6.**

## 1. Endpoints disponibles

Todos responden JSON con `cache-control: no-store` y cabecera `x-trace-id`. La sesión se envía como cookie HttpOnly `vc_session` (firmada).

| Método y ruta | Quién | Cuerpo | Éxito | Errores |
|---|---|---|---|---|
| `POST /api/demo/session` | cualquiera (solo `DEMO_MODE=true`) | `{ actorId }` | 200 `{ actorId, role, displayName, label: "Sesión simulada (demo)" }` + `Set-Cookie` | 400, 404 |
| `POST /api/agent/turn` | `OWNER` | `{ vehicleId, message (1–2000), serviceCode?: "ENGINE_OIL_FILTER" \| "TIMING_BELT", sessionId? }` (estricto, ≤ 8 KB) | 200 `TurnResult` (§2) | 400, 401, 403, 404, 409 (`SESSION_CLOSED`, `CONCURRENT_TURN`), 413, 415, 429 (`retry-after`) |
| `POST /api/bookings/confirm` | `OWNER` titular o `ADVISOR` con acceso | `{ confirmationToken }` | 200 `{ booking: { status: "CONFIRMED", bookingId, folio, startsAt, workshopId, totalCop, source, duplicate } }` o `{ status: "PENDING_RECONCILIATION", bookingId, escalatedCaseId }` | 401, 403 (`UNAUTHORIZED`, `AGENT_CANNOT_CONFIRM`), 404 (`INVALID_TOKEN`), 409 (`SLOT_CONFLICT`, `QUOTE_EXPIRED`, `INTENT_EXPIRED`, `INTENT_INVALIDATED`, `SAFETY_ESCALATED`, `ACTIVE_BOOKING_EXISTS`, `WORKSHOP_UNAVAILABLE`), 429 |

**Personas demo** (`DEMO_IDS.actors`):
- Propietarios: `act-owner-c1` (V1 `veh-demo-v1`), `act-owner-c2` (V2 `veh-demo-v2`), `act-owner-c3` (V3 `veh-demo-v3`, V4 `veh-demo-v4`).
- Personal: `act-advisor` (cartera C1 y C2), `act-ws-coord-t1`, `act-ws-coord-t2`, `act-compliance`.

## 2. `TurnResult`

```ts
{
  traceId: string; sessionId: string;
  assistant: { text: string; kind: "ASSISTANT" | "SYSTEM_NOTICE"; simulated: boolean; model: string };
  cards: Card[];
  journey: { state: JourneyState; allowedTools: string[] };
  trace: {
    toolCalls: Array<{ tool; ok; errorCode; source: "MOCK" | "REAL" | "INTERNAL"; durationMs; journeyStateAtCall; summary }>;
    llm: { provider: "ANTHROPIC" | "SCRIPTED"; model; iterations; inputTokens; outputTokens; stopReason };
    safety: { triggered: boolean; categories: string[] };
    guard: { blocked: boolean; violations: string[] };
    flags: string[];             // INJECTION_SUSPECT, THIRD_PARTY_DATA_REQUEST, OUTPUT_BLOCKED, REFUSAL…
  };
  errors: Array<{ code; message; retryable }>;   // recuperables: LLM_UNAVAILABLE, WORKSHOP_UNAVAILABLE, CONSENT_REQUIRED…
}
```

**Rótulos obligatorios en la UI** (AC11, AC14; «no presentar datos simulados como reales»):
- `assistant.simulated=true` → «Respuestas simuladas (ScriptedLlm), no IA generativa».
- `kind=SYSTEM_NOTICE` → «Mensaje del sistema».
- `source=MOCK` → «Taller simulado».
- `syntheticData=true` o `catalogVersion`/`sourceRef` con prefijo `SYNTHETIC-DEMO:` → «Dato/regla de demostración».

## 3. Tarjetas (`src/agent/cards.ts`)

| `type` | Campos clave | Acción de UI esperada |
|---|---|---|
| `EVALUATION` | `status`, `technicalStatus`, `dueBy{km,date}`, `remaining{km,days}`, `reasons`, `suggestedAction`, `plan{version,sourceRef}`, `syntheticData` | Mostrar motivo, unidad, regla, versión y fuente (AC02). `UNKNOWN` sin cifras (AC03) |
| `PLAN` | `version`, `sourceRef`, `rules[]` | Tabla de intervalos del plan validado |
| `WORKSHOPS` | `workshops[{workshopId,name,city}]` | Selector de taller |
| `QUOTE` | `subtotalCop`, `taxCop`, `totalCop`, `taxLabel`, `includedItems`, `restrictions`, `validUntil`, `catalogVersion`, `source` | Precio solo desde aquí (AC05) y vigencia visible |
| `SLOTS` | `workshopId`, `slots[{slotRef,startsAt,endsAt}]` | Elegir horario (el usuario lo indica en el chat) |
| `BOOKING_INTENT` | `intentId`, `expiresAt`, `summary`, `requiresUserConfirmation`, **`confirmationToken` (solo en vivo)** | Botón «Confirmar reserva» → `POST /api/bookings/confirm`. **No guardar el token** en almacenamiento persistente |
| `HUMAN_CASE` | `caseId`, `reason`, `priority`, `slaDueAt` | Referencia del caso |
| `SAFETY` | `caseId`, `categories`, `lexiconVersion` | Banner de seguridad persistente; ocultar acciones comerciales |
| `ODOMETER_RECORDED` | `readingId`, `valueKm`, `verification` | «Dato declarado (no verificado)» |

`journey.allowedTools` permite deshabilitar en la UI las acciones que el servidor rechazaría.

## 4. Lo que la Fase 6 necesitará y aún no existe

| Necesidad (AC) | Propuesta | Datos ya disponibles |
|---|---|---|
| Ficha del vehículo (AC01) | `GET /api/vehicles/:id/profile` → `getVehicleProfile` | caso de uso listo |
| Historial con procedencia (AC11) | `GET /api/vehicles/:id/history` → `getServiceHistory` | caso de uso listo |
| Reanudar conversación | `GET /api/agent/sessions/:id/messages` (mensajes **redactados** de `ConversationMessage`) | tabla lista (append-only) |
| Panel «qué hizo el agente» (AC04/AC12) | `GET /api/traces/:traceId` para el propietario (su sesión) y `AUDIT_READ` con justificación para compliance (ADR-016) | `ToolCall`, `JourneyEvent`, `AuditLog`, `MaintenanceEvaluation.decisionTrace` |
| Estado del journey y actor responsable (AC12) | `GET /api/vehicles/:id/journey?serviceCode=` + `verifyJourneyConsistency` | `JourneyEvent` con actor |
| Bandeja de casos (asesor) | `GET /api/cases`, `POST /api/cases/:id/resolve` → `resolveHumanCase` | caso de uso listo (asignación obligatoria) |
| Asignación de casos (supervisor) | endpoint y rol nuevos (D-34) | — |
| Consola de taller | `POST /api/work-orders` (`openWorkOrder`), `POST /api/work-orders/:id/complete` (`completeWorkOrder`), con rótulo «SIMULACIÓN» | casos de uso listos |
| Reconciliación | `POST /api/bookings/:id/reconcile` (asesor) o job | `reconcileBooking` listo |
| Preferencias y consentimiento (EX-04, D-12) | `GET/POST /api/consents` | modelo `Consent`/`ConsentEvent` listo |
| Selector de persona demo | consume `POST /api/demo/session` | listo |

## 5. Variables de entorno

`DATABASE_URL`, `SESSION_SECRET` (≥ 32), `LOG_HASH_SECRET`, `DEMO_MODE`, `LLM_PROVIDER` (`scripted` | `anthropic`), `LLM_MODEL`, `LLM_EFFORT`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_SERVER_FALLBACKS`, `AGENT_TURNS_PER_MINUTE`, `BOOKING_CONFIRMS_PER_MINUTE`, `AGENT_MAX_ITERATIONS`, `AGENT_MAX_OUTPUT_TOKENS_PER_TURN`, `AGENT_TURN_TIMEOUT_MS`. Con `anthropic`: `ANTHROPIC_API_KEY` (o un perfil `ant auth login`).
