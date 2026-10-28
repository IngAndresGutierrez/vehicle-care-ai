# Vehicle Care — Arquitectura técnica del MVP (Colombia)

**Versión:** 0.1 (diseño, sin implementación) · **Fecha:** 28-oct-2026 · **Base:** `PRD_Vehicle_Care_v1.md` v1.0
**Stack:** Next.js (App Router) · TypeScript estricto · PostgreSQL · Prisma · Vitest · Zod
**Documentos hermanos:** [`DATA_MODEL.md`](./DATA_MODEL.md) · [`AGENT_DESIGN.md`](./AGENT_DESIGN.md) · [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)

> Convención: **[D-xx]** = decisión pendiente, **[A-xx]** = supuesto. El listado consolidado está en §12.

---

## 1. Drivers de arquitectura

| # | Driver (origen en PRD) | Consecuencia arquitectónica |
|---|---|---|
| AD-1 | «La IA conversa y orquesta; no inventa intervalos» (§0, §7) | El cálculo vive en un **módulo puro** (`maintenance-engine`) sin I/O ni LLM. El agente solo puede *leer* su resultado. |
| AD-2 | Mutaciones solo con permiso, confirmación explícita e idempotencia (§8.1, AC06, AC09) | Todas las herramientas pasan por un **Tool Gateway** que aplica authz, consentimiento, guardas de estado e idempotencia **en código**, no en el prompt. |
| AD-3 | Excepciones de seguridad interrumpen el journey comercial (EX-02, AC08) | **Máquina de estados** explícita con estado `SAFETY_ESCALATED` que bloquea herramientas comerciales a nivel de gateway. Detección de síntomas determinista *antes* del LLM. |
| AD-4 | Trazabilidad por decisión (§10, AC04, AC12) | `trace_id` por turno; eventos de journey **inmutables**; registro de cada llamada a herramienta; `decision_trace` persistido por evaluación. |
| AD-5 | Integraciones reales no disponibles en 24 h (§4, S02) | **Puertos y adaptadores**: CRM, taller (catálogo, cotización, agenda, órdenes), casos humanos y notificaciones son interfaces con adaptadores *mock* con inyección de fallos. |
| AD-6 | Procedencia de datos (AC11, §10 fraude) | Cada lectura de odómetro y registro de servicio lleva `provenance` (quién lo respalda: `WORKSHOP_VERIFIED`, `DELIVERY_INSPECTION`, `PRIOR_OWNER_DOCUMENT`, `OWNER_DECLARED`) y, ortogonalmente, `dataOrigin` (`REAL` / `SYNTHETIC`) con fuente rotulada (ADR-011). El cliente nunca escribe registros certificados. |
| AD-7 | Ley 1581 de 2012 — finalidad y consentimiento (§10) | Consentimiento **por finalidad y canal**, con evidencia y revocación; la salida a canales externos está detrás de un `ConsentPolicy` que falla cerrado. |
| AD-8 | Prueba de 24 h, demo navegable | Monolito modular en Next.js; un solo despliegue; sin colas ni microservicios. Fronteras de módulo preparadas para extraer después. |

---

## 2. Vista de contexto (C4 nivel 1)

```
                ┌───────────────────────┐
  Propietario ─▶│                       │◀── Asesor postventa / Coordinador de taller /
  (web, móvil)  │   Vehicle Care (MVP)  │    Compliance (consolas internas)
                │   Next.js monolito    │
                └──────────┬────────────┘
                           │ puertos (interfaces TS)
     ┌──────────────┬──────┴───────┬─────────────────┬──────────────────┐
     ▼              ▼              ▼                 ▼                  ▼
  CRM / DMS     Taller:         Casos humanos    Notificaciones     Proveedor LLM
  (cliente,     catálogo,       (cola de         (email/WhatsApp:   (Anthropic
  entrega,      cotizador,      asesores)        **solo log** en    Messages API)
  consents)     agenda, OT                       el MVP)
  ── MOCK ──    ── MOCK ──      ── interno ──    ── MOCK ──         ── real o Scripted ──
```

Fuera del MVP (no hay puerto): RUNT, SIMIT, aseguradoras, pagos, telemática.

---

## 3. Vista de contenedores y módulos (C4 nivel 2–3)

Un único contenedor Next.js + PostgreSQL. Dentro, un **monolito modular** con dependencias en una sola dirección:

```
 app/ (UI + Route Handlers)           ← capa de entrega (HTTP, RSC, Server Actions)
   │
   ▼
 application/ (casos de uso)          ← orquesta transacciones, eventos, autorización
   │        │                │
   ▼        ▼                ▼
 agent/   domain/          integrations/ports
 (LLM     ├ maintenance-     (interfaces)
 loop,    │   engine (puro)       ▲
 tool     ├ journey (FSM pura)    │ implementan
 gateway) ├ policies (puras)  integrations/mock  (adaptadores mock + fault injection)
          └ value objects     infra/ (Prisma, logger, clock, ids, llm client)
```

Reglas de dependencia (verificables con `eslint-plugin-boundaries` o `dependency-cruiser` **[D-14]**):

- `domain/**` no importa nada de `infra`, `integrations`, `agent`, `app`, Prisma ni Next. Solo TS + utilidades puras de fechas.
- `agent/**` no accede a Prisma directamente: llama casos de uso de `application/`.
- `integrations/mock/**` solo se instancia desde el *composition root* (`infra/container.ts`).
- El reloj (`Clock`) se inyecta en todo lo que dependa de «hoy» → tests deterministas.

### 3.1 Estructura de carpetas propuesta

```
prisma/
  schema.prisma
  seed.ts                       # 3 vehículos sintéticos, 2 talleres, cupos limitados
prisma.config.ts
src/
  app/
    (owner)/vehicles/[vehicleId]/page.tsx       # ficha → plan → chat → cotización → agenda
    (ops)/ops/traces/page.tsx                    # panel «qué hizo el agente» (AC04, AC12)
    (ops)/ops/cases/page.tsx                     # bandeja de casos humanos
    (workshop)/workshop/work-orders/page.tsx     # consola taller: «Simular cierre» (rotulado)
    api/
      agent/turn/route.ts                        # POST: un turno conversacional
      bookings/confirm/route.ts                  # POST: confirmación explícita (UI → token)
      jobs/evaluate/route.ts                     # POST: job de evaluación (manual/cron)
      workshop/work-orders/[id]/complete/route.ts# solo rol taller
      demo/session/route.ts                      # selector de persona demo (rotulado)
  domain/
    maintenance-engine/  (evaluate.ts, types.ts, reasons.ts, date-math.ts, __tests__/)
    journey/             (machine.ts, states.ts, events.ts, guards.ts, __tests__/)
    policies/            (consent-policy.ts, access-policy.ts, safety-lexicon.ts)
    shared/              (money.ts, odometer.ts, result.ts, errors.ts)
  application/
    evaluate-vehicle.ts, record-odometer.ts, request-quote.ts, list-slots.ts,
    create-booking.ts, open-human-case.ts, complete-work-order.ts, run-evaluation-job.ts
  agent/
    orchestrator.ts      # loop de tool use
    gateway.ts           # Tool Gateway (authz, consent, FSM guard, idempotency, trace)
    tools/               # un archivo por herramienta: schema Zod + handler
    prompts/             # system prompt versionado
    safety/              # pre-clasificador determinista + respuestas aprobadas
    output-guard.ts      # validación de la respuesta del LLM (precios, promesas)
    memory.ts            # memoria estructurada por sesión/vehículo
  integrations/
    ports/               (crm.ts, workshop.ts, cases.ts, notifications.ts, llm.ts)
    mock/                (mock-crm.ts, mock-workshop.ts, fault-injector.ts, fixtures/)
  infra/
    prisma.ts, container.ts, clock.ts, ids.ts, logger.ts, anthropic.ts, scripted-llm.ts
tests/
  integration/  e2e-journeys/  evals/
```

---

## 4. Flujos principales (secuencias)

### 4.1 Evaluación (job) → tarjeta «próximo servicio»

```
Cron/botón ─▶ POST /api/jobs/evaluate
  run-evaluation-job
    para cada vehículo elegible (segmento P0, plan asignado):
      EvaluationContextBuilder (I/O: Prisma) ─▶ EvaluationInput (inmutable)
      maintenanceEngine.evaluate(input, commPolicy, clock.now())   ← puro
      persistir MaintenanceEvaluation (+ decisionTrace, engineVersion, inputHash)
      journey.dispatch(EVALUATED{status})
      si status ∈ {UPCOMING, DUE, OVERDUE}:
          consentPolicy.canContact(owner, purpose=MAINTENANCE_REMINDERS, channel)
            ├ sí  → NotificationPort.send (mock: solo log, rotulado) + evento CONTACT_SENT
            └ no  → OutboundMessage{status=SUPPRESSED, consentEventId=null} + evento CONTACT_SUPPRESSED{reason=CONSENT_REQUIRED};
                    solo tarjeta en portal (EX-04, ADR-010)
```

### 4.2 Turno conversacional

```
UI ─▶ POST /api/agent/turn {sessionId, message}
  1. authn (sesión demo) → actor; access-policy: actor ↔ vehicle (titularidad vigente)
  2. trace_id nuevo; mensaje del usuario persistido como dato NO confiable
  3. safety pre-classifier (determinista) ── hit ─▶ ruta de seguridad (sin LLM comercial):
        createHumanCase(SAFETY_ESCALATION, URGENT) → FSM SAFETY_ESCALATED
        → respuesta plantilla aprobada + case_id                         (EX-02)
  4. orchestrator: LLM + tools (máx. N iteraciones) — cada tool_use pasa por Tool Gateway:
        validar schema → inyectar contexto (actor, vehicle, trace) → authz → consentimiento
        → guardia FSM (¿herramienta permitida en el estado actual?) → idempotencia
        → handler (caso de uso) → registrar ToolCall → resultado tipado al LLM
  5. output-guard: precios/folios en texto deben coincidir con tool results; si no, se bloquea
  6. respuesta = texto + «tarjetas» estructuradas renderizadas desde tool results (no desde texto)
  7. panel de trazas recibe resumen de herramientas consultadas (AC04)
```

### 4.3 Reserva con confirmación explícita (anti-«reserva alucinada»)

```
Agente: getAvailableSlots → UI muestra cupos (tarjeta) → usuario elige
Agente: prepareBooking(slot_id, quote_id) → crea BookingIntent{confirmationToken, expiresAt}
UI: botón «Confirmar reserva» (acción humana, no texto libre)
  ─▶ POST /api/bookings/confirm {confirmationToken} (Idempotency-Key = hash(token))
       create-booking: revalida quote vigente + cupo vía WorkshopPort.createBooking(idempotencyKey)
         ├ ok            → Booking CONFIRMED + evento BOOKING_CONFIRMED → folio en UI
         ├ SLOT_CONFLICT → evento BOOKING_FAILED; FSM vuelve a SLOT_SELECTION; nuevos cupos (EX-03)
         └ QUOTE_EXPIRED → vuelve a QUOTE; recotizar
```

El LLM **nunca** puede pasar `explicit_confirmation=true`: la confirmación es un token emitido por el servidor y consumido solo por un clic del usuario. Ver `AGENT_DESIGN.md §4`.

### 4.4 Cierre de taller

Solo `role=WORKSHOP_*` puede invocar `completeWorkOrder` (route handler propio, fuera del catálogo del agente). Crea `ServiceRecord{provenance=WORKSHOP_VERIFIED}` + `OdometerReading{WORKSHOP_VERIFIED}`, re-evalúa el plan y emite `SERVICE_COMPLETED`. En la demo, el botón está rotulado **«SIMULACIÓN — cierre de taller»** y el registro queda con `provenance=WORKSHOP_VERIFIED` + `dataOrigin=SYNTHETIC` y fuente `SYNTHETIC-DEMO:` (ADR-011, resuelve D-09).

---

## 5. Maintenance Engine (módulo determinista)

### 5.1 Contrato (implementado en Fase 1)

Fuente de verdad: `src/domain/maintenance-engine/types.ts`. Resumen:

```ts
export function evaluate(input: EvaluationInput, policies: EvaluationPolicies, now: Date): EvaluationResult;

// Entrada técnica (ensamblada fuera del dominio por EvaluationContextBuilder)
EvaluationInput = {
  vehicleId, serviceCode,
  spec: { engineCode: string | null; timingDrive: 'BELT' | 'CHAIN' | 'UNKNOWN'; market },
  plan: null | { planVersionId, version, status: 'VALIDATED' | 'DRAFT' | 'RETIRED',
                 sourceRef,            // sintético ⇒ prefijo obligatorio "SYNTHETIC-DEMO:" (ADR-011)
                 dataOrigin: 'SYNTHETIC' | 'REAL',
                 rules: MaintenanceRuleInput[] },  // {intervalKm, intervalMonths, appliesToTimingDrive, usageCondition,
                                                   //  requiresUsageCondition, allowDeliveryBaseline}
  usageCondition: 'NORMAL' | 'SEVERE' | null,
  lastService: null | { recordId, serviceCode, performedOn: 'YYYY-MM-DD', odometerKm, provenance, dataOrigin },
  odometer:    null | { readingId, valueKm, observedAt: ISO-8601 con zona, provenance, dataOrigin },
  odometerHistory: { valueKm, observedAt }[],
}

// Políticas NO técnicas, versionadas por separado (ADR-012)
EvaluationPolicies = {
  communication: { policyVersion, dataOrigin, leadKm, leadDays, overdueGraceKm, overdueGraceDays },
  dataQuality:   { policyVersion, maxOdometerAgeDays },
}

EvaluationResult = {
  status: 'NOT_DUE' | 'UPCOMING' | 'DUE' | 'OVERDUE' | 'NOT_APPLICABLE' | 'UNKNOWN',   // consolidado
  technical: { status: 'NOT_DUE' | 'DUE' | 'NOT_APPLICABLE' | 'UNKNOWN',               // solo plan + historial
               dueBy: { km, date } | null, remaining: { km, days } | null,              // con signo; null si UNKNOWN
               reachedBy: 'KM' | 'TIME' | 'BOTH' | null },
  communication: { status: 'NOT_DUE' | 'UPCOMING' | 'DUE' | 'OVERDUE', policyVersion, triggeredBy } | null,
  reasons: ReasonCode[], requiresOdometerConfirmation, suggestedAction,
  plan: { planVersionId, version, sourceRef } | null, ruleId,
  dataOrigin: { containsSyntheticData, syntheticSources[] },                           // ADR-011
  asOf: { instant, localDate, timeZone: 'America/Bogota' },
  engineVersion, dataQualityPolicyVersion, inputHash /* sha256(input+políticas+now) */, decisionTrace,
}
```

El motor no lanza por datos de negocio inválidos (devuelve `UNKNOWN[INVALID_INPUT]`); solo lanza si `now` no es una fecha válida.

### 5.2 Algoritmo (orden estricto, primer *gate* que falla corta)

0. **Validación de entrada** → `UNKNOWN(INVALID_INPUT)`: km enteros ≥ 0, intervalos enteros > 0, fechas `YYYY-MM-DD` válidas, instantes ISO **con zona explícita**, `lastService.serviceCode` coherente, políticas enteras ≥ 0 y rótulo sintético coherente (`dataOrigin=SYNTHETIC` ⇔ `sourceRef` empieza por `SYNTHETIC-DEMO:`).
1. **Identidad técnica** → `UNKNOWN`: `PLAN_MISSING`, `PLAN_NOT_VERIFIED` (status ≠ `VALIDATED`), `ENGINE_UNIDENTIFIED`, `RULE_MISSING_FOR_SERVICE`, `USAGE_CONDITION_REQUIRED` (hay reglas por condición de uso y no se conoce), `RULE_WITHOUT_INTERVAL`.
2. **Aplicabilidad**: regla con `appliesToTimingDrive='BELT'` y vehículo `CHAIN` → `NOT_APPLICABLE`. Si `timingDrive='UNKNOWN'` → `UNKNOWN(TIMING_DRIVE_UNKNOWN)`. *Nunca* asumir correa ni cadena.
3. **Consistencia** → `UNKNOWN(CONTRADICTORY_RECORDS)`: lecturas o servicio con fecha futura; odómetro decreciente; lectura posterior al servicio con km menor que el del servicio.
4. **Línea base documentada** → `UNKNOWN(INSUFFICIENT_HISTORY)` si no hay último servicio; además `BASELINE_NOT_DOCUMENTED` si solo está declarado por el propietario (D-29) y `DELIVERY_BASELINE_NOT_ALLOWED` si es el alistamiento y la regla no lo permite (D-04). Nunca usar «0 km» ni la fecha de compra.
5. **Vencimiento técnico** por dimensión (solo límites que existan en la regla):
   - `dueBy.km = lastService.odometerKm + intervalKm`; `dueBy.date = addMonthsClamped(performedOn, intervalMonths)` en calendario de `America/Bogota` (31-ene + 1 mes = 28-feb).
   - Límite **inclusivo**: alcanzado si `remaining ≤ 0`.
   - **Odómetro obsoleto** (`> maxOdometerAgeDays`, política de calidad de datos): la lectura es una cota inferior. Si ya alcanza el límite es concluyente; si no, la dimensión KM es no concluyente y `requiresOdometerConfirmation=true`. Sin lectura: `ODOMETER_MISSING`. Sin proyección de km **[D-06]**.
   - Técnico `DUE` si alguna dimensión concluyente alcanzó el límite; `NOT_DUE` si todas son concluyentes y ninguna lo alcanzó; si no, `UNKNOWN(ODOMETER_STALE|ODOMETER_MISSING)` con `CONFIRM_ODOMETER`.
6. **Clasificación de comunicación** (ADR-012; no altera el paso 5): técnico `DUE` → `OVERDUE` si se excede en ≥ `overdueGraceKm`/`overdueGraceDays`, si no `DUE`; técnico `NOT_DUE` → `UPCOMING` si faltan ≤ `leadKm`/`leadDays`, si no `NOT_DUE`.
7. **Acción sugerida**: `UNKNOWN` → `CONFIRM_ODOMETER` (solo motivos de odómetro) o `HUMAN_REVIEW`; `UPCOMING/DUE/OVERDUE` → `OFFER_QUOTE`; `NOT_DUE/NOT_APPLICABLE` → `NONE`.

Propiedades verificadas con `fast-check`: determinismo (ME-P1), monotonicidad en km y tiempo (ME-P2), `UNKNOWN` ⇒ sin cifras (ME-P3) e **invariancia del estado técnico ante cualquier política de comunicación** (ME-P4).

### 5.3 Ejemplo del PRD como test de oro (ME-01)

Regla sintética 5.000 km / 12 meses, último servicio 70.000 km el 2026-04-01, lectura 74.200 km el 2026-10-28, `leadKm=1000` → técnico `NOT_DUE` con `dueBy={km:75000, date:'2027-04-01'}`, `remaining={km:800, days:155}`; comunicación `UPCOMING` por `KM`. Fixture rotulado `SYNTHETIC-DEMO`.

---

## 6. Máquina de estados del journey (UC-01)

**Implementado en Fase 3** (ADR-015; Fase 4 añade la recotización desde `SLOT_SELECTION`, ADR-017): tabla declarativa pura en `src/domain/journey/machine.ts` (sin librería; resuelve D-07), `allowedTools(state)` en `tools.ts`, reproducción y verificación en `replay.ts`. Los eventos se aplican con `src/application/journey/journey-store.ts`. Persistencia: `JourneyInstance.state` + `version` (bloqueo optimista) y `JourneyEvent` append-only. El estado se reconstruye o valida desde eventos en tests.

### 6.1 Estados

| Estado | Significado | Herramientas del agente permitidas |
|---|---|---|
| `ACTIVATED` | Vehículo registrado tras entrega; plan asignado o pendiente | lectura |
| `PLAN_PENDING_VERIFICATION` | Sin plan validado para la especificación | lectura, `createHumanCase` |
| `MONITORING` | Evaluado `NOT_DUE`/`NOT_APPLICABLE` | lectura |
| `NEED_DETECTED` | Evaluado `UPCOMING/DUE/OVERDUE` | lectura |
| `CONTACT_SUPPRESSED` | Necesidad sin consentimiento de contacto (EX-04); solo portal | lectura |
| `CONVERSATION_OPEN` | El propietario abrió la tarjeta/chat | lectura, `recordOdometer`, `evaluateMaintenance` |
| `AWAITING_CONTEXT` | Falta/antiguo odómetro u otro dato declarable | `recordOdometer`, `evaluateMaintenance`, `createHumanCase` |
| `RECOMMENDATION_PRESENTED` | Resultado del motor explicado con fuente/versión | + `getQuote` |
| `QUOTE_PRESENTED` | Cotización vigente mostrada | + `getAvailableSlots` |
| `QUOTE_PENDING_HUMAN` | Catálogo no devolvió precio → caso humano | `createHumanCase` |
| `SLOT_SELECTION` | Cupos mostrados | `getAvailableSlots`, `prepareBooking` |
| `AWAITING_CONFIRMATION` | `BookingIntent` emitido; espera clic | ninguna mutación del agente |
| `BOOKED` | `createBooking` OK, folio confirmado | lectura |
| `IN_SERVICE` | Vehículo en taller (OT abierta) | lectura |
| `SERVICE_COMPLETED` | Taller confirmó cierre | lectura |
| `FOLLOW_UP` | Re-evaluación y encuesta | lectura |
| `HUMAN_REVIEW` | Caso humano abierto (incertidumbre/insuficiencia) | lectura |
| `SAFETY_ESCALATED` | Síntoma crítico; flujo comercial bloqueado | **ninguna comercial**; solo lectura del caso |
| `CLOSED` | Fin del ciclo (completado, cancelado o resuelto por humano) | — |

### 6.2 Transiciones principales

```
ACTIVATED ──EVALUATED(NOT_DUE|N/A)──▶ MONITORING ──EVALUATED(UPCOMING..)──▶ NEED_DETECTED
ACTIVATED ──PLAN_MISSING──▶ PLAN_PENDING_VERIFICATION ──PLAN_VALIDATED──▶ ACTIVATED
NEED_DETECTED ──CONTACT_SENT──▶ NEED_DETECTED   |  ──CONTACT_SUPPRESSED──▶ CONTACT_SUPPRESSED
NEED_DETECTED|CONTACT_SUPPRESSED|MONITORING ──OWNER_OPENED──▶ CONVERSATION_OPEN
CONVERSATION_OPEN ──EVALUATED(requiresOdometerConfirmation)──▶ AWAITING_CONTEXT
AWAITING_CONTEXT ──ODOMETER_RECORDED→EVALUATED──▶ CONVERSATION_OPEN
CONVERSATION_OPEN ──RECOMMENDATION_SHOWN──▶ RECOMMENDATION_PRESENTED
*  ──EVALUATED(UNKNOWN, HUMAN_REVIEW)→HUMAN_CASE_OPENED──▶ HUMAN_REVIEW              (EX-01)
RECOMMENDATION_PRESENTED ──QUOTE_ISSUED──▶ QUOTE_PRESENTED
RECOMMENDATION_PRESENTED ──QUOTE_UNAVAILABLE→HUMAN_CASE_OPENED──▶ QUOTE_PENDING_HUMAN
QUOTE_PRESENTED ──SLOTS_LISTED──▶ SLOT_SELECTION ──BOOKING_INTENT_CREATED──▶ AWAITING_CONFIRMATION
AWAITING_CONFIRMATION ──BOOKING_CONFIRMED──▶ BOOKED
AWAITING_CONFIRMATION ──BOOKING_FAILED(SLOT_CONFLICT|NO_SLOTS)──▶ SLOT_SELECTION       (EX-03)
AWAITING_CONFIRMATION ──BOOKING_FAILED(QUOTE_EXPIRED)──▶ RECOMMENDATION_PRESENTED
AWAITING_CONFIRMATION ──INTENT_EXPIRED──▶ SLOT_SELECTION
BOOKED ──WORK_ORDER_OPENED──▶ IN_SERVICE ──WORK_ORDER_COMPLETED──▶ SERVICE_COMPLETED
SERVICE_COMPLETED ──REEVALUATED──▶ FOLLOW_UP ──FEEDBACK_RECEIVED|TIMEOUT──▶ MONITORING
*(cualquier estado no terminal) ──SAFETY_SIGNAL──▶ SAFETY_ESCALATED                     (EX-02)
SAFETY_ESCALATED ──CASE_RESOLVED_BY_HUMAN(clearedForService)──▶ CONVERSATION_OPEN | CLOSED
HUMAN_REVIEW ──CASE_RESOLVED_BY_HUMAN──▶ ACTIVATED (re-evaluar) | CLOSED
BOOKED ──BOOKING_CANCELLED──▶ MONITORING   (P1: cancelación; en MVP solo vía asesor)
```

Invariantes (tests de FSM):

- Desde `SAFETY_ESCALATED` solo un actor humano (`ADVISOR`/`COMPLIANCE`) sale del estado; el agente no.
- `BOOKED` solo se alcanza con evento `BOOKING_CONFIRMED` que referencia un `Booking` con `externalBookingId` no nulo.
- `SERVICE_COMPLETED` solo con actor de rol taller.
- Transición no definida ⇒ error tipado `INVALID_TRANSITION`, nunca *no-op* silencioso.
- Una `BOOKED` previa (reserva activa) impide un segundo `BookingIntent` para el mismo servicio.

---

## 7. Arquitectura de integración (CRM, taller, reservas)

> **Implementado en Fase 4** (ADR-017): `src/integrations/ports/{workshop,crm,notifications}.ts`; MOCK en `src/integrations/mock/` (sistema de taller simulado + adaptador anticorrupción, CRM y escenarios de fallo). Los contratos finales difieren del borrador de abajo: `getSlot`, `findBooking`, `cancelBooking`, `openWorkOrder`, `completeWorkOrder` y el código `OUTCOME_UNCERTAIN`.

### 7.1 Puertos

```ts
// src/integrations/ports/crm.ts
export interface CrmPort {
  getCustomer(customerRef: string): Promise<CrmResult<CrmCustomer>>;
  getDeliveryRecord(vehicleRef: string): Promise<CrmResult<CrmDelivery>>; // fecha entrega, odómetro PDI, docs
  getConsents(customerRef: string): Promise<CrmResult<CrmConsent[]>>;
  recordInteraction(evt: CrmInteraction): Promise<CrmResult<{ interactionId: string }>>; // con idempotencyKey
}

// src/integrations/ports/workshop.ts
export interface WorkshopPort {
  getQuote(req: { workshopId: string; serviceCode: ServiceCode; vehicleSpec: SpecRef }): Promise<WsResult<WsQuote>>;
  listSlots(req: { workshopId: string; serviceCode: ServiceCode; from: Date; to: Date }): Promise<WsResult<WsSlot[]>>;
  createBooking(req: { slotId: string; quoteId: string; customerRef: string; vehicleRef: string },
                idempotencyKey: string): Promise<WsResult<WsBooking>>;     // revalida cupo del lado del taller
  getWorkOrder(workOrderId: string): Promise<WsResult<WsWorkOrder>>;
}

// src/integrations/ports/cases.ts  — en MVP implementado internamente (tabla HumanCase)
export interface HumanCasePort { open(c: NewHumanCase, idempotencyKey: string): Promise<CaseResult<{caseId: string; assignee: string; slaDueAt: Date}>> }

// src/integrations/ports/notifications.ts — mock: escribe OutboundMessage{status=SIMULATED_SENT, dataOrigin=SYNTHETIC}
export interface NotificationPort { send(msg: OutboundMessage, consentProof: ConsentProof): Promise<NotifResult> }
```

`*Result<T>` es una unión discriminada `{ ok: true, data } | { ok: false, error: { code, retryable, raw? } }`. Los adaptadores **nunca lanzan** por errores de negocio; solo por bugs.

### 7.2 Capa anticorrupción

Cada adaptador mapea al modelo de dominio: códigos de servicio del taller ↔ `ServiceCode` interno (tabla `ServiceCodeMapping`), montos a COP enteros, horarios a UTC con zona `America/Bogota` explícita. Errores externos → `ToolErrorCode` del PRD (`NO_SLOTS`, `SLOT_CONFLICT`, `QUOTE_EXPIRED`, `WORKSHOP_UNAVAILABLE`).

### 7.3 Mocks con inyección de fallos

- **Estado persistente en PostgreSQL** (tablas `Mock*`, ver `DATA_MODEL.md §4`) para que cupos y reservas sobrevivan entre requests y despliegues serverless **[D-08]**.
- `FaultInjector` configurable por escenario (fila `MockScenario` o cabecera `x-demo-scenario` solo en entorno demo): `SLOT_CONFLICT_ON_NEXT_BOOKING`, `QUOTE_UNAVAILABLE`, `WORKSHOP_DOWN`, `LATENCY_MS`.
- Idempotencia del lado del mock: `MockBooking.idempotencyKey` único → reintento devuelve la misma reserva (prueba AC09).
- Cupos con concurrencia real: `UPDATE ... WHERE id=? AND remainingCapacity > 0` en transacción → el conflicto es reproducible, no simulado con `if`.
- Todo lo mock se rotula en UI y en el panel de trazas (`source: 'MOCK'`) — AC14.

### 7.4 Qué requeriría producción (resumen para AC14)

| Puerto | MVP | Producción |
|---|---|---|
| CrmPort | Mock sobre tablas seed | API del CRM/DMS de la agencia (Salesforce/HubSpot/DMS local **[D-10]**), OAuth2 cliente-credenciales, sincronización incremental o webhooks |
| WorkshopPort | Mock con cupos en Postgres | API del sistema de taller/DMS; webhook de cierre de OT firmado (HMAC); SLA y reintentos con backoff |
| HumanCasePort | Tabla interna + bandeja `/ops/cases` | Ticketing del CRM o cola de contact center con SLA |
| NotificationPort | `OutboundMessage` con `SIMULATED_SENT` (nada sale del sistema) | WhatsApp Business API / email con plantillas aprobadas y prueba de opt-in |
| LLM | Anthropic API o `ScriptedLlm` | Anthropic API con DPA, minimización de PII, retención acordada |

---

## 8. Seguridad, privacidad y cumplimiento (Ley 1581)

- **Autenticación demo**: selector de persona sintética con cookie firmada (`iron-session` o JWT firmado) rotulado «Sesión simulada» **[D-11]**. El diseño deja un `AuthPort` para OTP/SSO real.
- **Autorización** (`access-policy.ts`): `actor` accede a `vehicle` solo si existe `VehicleOwnership` vigente (no por VIN/placa). Roles: `OWNER`, `ADVISOR`, `WORKSHOP_COORDINATOR`, `TECHNICIAN`, `COMPLIANCE`, `SYSTEM_AGENT`. Matriz rol × herramienta en `AGENT_DESIGN.md §5`.
- **Consentimiento**: por finalidad (`SERVICE_OPERATIONAL`, `MAINTENANCE_REMINDERS`, `MARKETING`, `AI_ASSISTANT_PROCESSING` **[D-12]**) y canal; versión del texto legal aceptado, evidencia, revocación. Falla cerrado.
- **Minimización hacia el LLM**: el modelo recibe `vehicleId` opaco, especificación técnica, estado del motor y alias del propietario; **no** recibe documento de identidad, teléfono, email ni placa completa **[D-13]**.
- **Logs**: `vehicleId` pseudonimizado (HMAC con sal) en `ToolCall`/`AuditLog`; sin secretos ni PII innecesaria; política de retención configurable.
- **Fraude**: el propietario no puede crear `ServiceRecord` con `WORKSHOP_VERIFIED`; lecturas declaradas se marcan `OWNER_DECLARED` y una lectura menor a la última verificada se rechaza (`ODOMETER_ROLLBACK`); rate limit por actor en `/api/agent/turn` y `/api/bookings/confirm`.
- **Prompt injection**: ver `AGENT_DESIGN.md §6` (contexto inyectado por servidor, herramientas sin parámetro de identidad, salida validada).

---

## 9. Observabilidad y trazabilidad

- `trace_id` (ULID) por turno; `span` por llamada a herramienta. Se propaga a adaptadores y eventos.
- Tablas: `ToolCall` (entrada redactada, resultado resumido, `errorCode`, `durationMs`, `source: MOCK|REAL`), `JourneyEvent`, `MaintenanceEvaluation.decisionTrace`, `AuditLog` (acciones humanas).
- **Panel «qué hizo el agente»** (AC04/AC12): línea de tiempo por `trace_id` → herramientas, motivo, regla aplicada, versión de plan, transición de estado, actor responsable, handoff.
- Logger estructurado (pino) con `trace_id`; OpenTelemetry opcional después del MVP.

---

## 10. Estrategia de pruebas (Vitest)

| Nivel | Alcance | Herramientas | Dónde |
|---|---|---|---|
| Unit — puro | Motor, FSM, políticas, safety lexicon, output guard, mapeos | Vitest, `fast-check`, reloj fijo | `src/**/__tests__` |
| Integración | Casos de uso + Prisma + mocks (cupo concurrente, idempotencia, consent) | Vitest + Postgres efímero (Docker/Testcontainers **[D-15]**), transacción por test | `tests/integration` |
| Contrato | Schemas Zod de herramientas y puertos; mocks cumplen el contrato | Vitest | `tests/integration/contracts` |
| Journey E2E (API) | UC-01 éxito, EX-01, EX-02, EX-03, EX-04 de punta a punta con `ScriptedLlm` | Vitest invocando route handlers | `tests/e2e-journeys` |
| Evals de agente | 20+ casos (PRD §10) con LLM real, aserciones sobre herramientas llamadas y estado | Vitest suite separada (`vitest --project evals`), no bloquea CI por coste **[D-16]** | `tests/evals` |
| UI E2E (opcional) | Recorrido navegable móvil/escritorio, accesibilidad | Playwright + axe **[D-17]** | `tests/ui` |

El catálogo de casos está en `IMPLEMENTATION_PLAN.md §4`.

---

## 11. Decisiones de arquitectura (ADR resumidos)

| ADR | Decisión | Alternativa descartada | Motivo |
|---|---|---|---|
| ADR-01 | Monolito modular Next.js | Microservicios / backend separado | 24 h, un despliegue; fronteras de módulo preservan extracción futura |
| ADR-02 | Motor de mantenimiento como función pura con input ensamblado fuera | Reglas en BD evaluadas por SQL; LLM con RAG del manual | Testeable, reproducible (`inputHash`), auditable; cumple «sin LLM para el cálculo» |
| ADR-03 | Tool Gateway aplica políticas en código | Restricciones solo en system prompt | Los prompts no son controles de seguridad |
| ADR-04 | Confirmación de reserva vía token de UI | Booleano `explicit_confirmation` del LLM | El modelo podría fabricarlo; AC06 exige aprobación humana real |
| ADR-05 | Detección de seguridad determinista antes del LLM + herramienta de escalamiento para el LLM | Solo el LLM decide | Recall alto y respuesta aprobada por personal cualificado (EX-02) |
| ADR-06 | Mocks con estado en Postgres y fallos inyectables | Mocks en memoria | Serverless sin estado compartido; conflictos reproducibles |
| ADR-07 | Un solo agente (`MaintenanceAdvisor`) | Multiagente | PRD §8; menos superficie de fallo |
| ADR-08 | Proveedor LLM detrás de `LlmPort` con `ScriptedLlm` para tests | Acoplar SDK | Tests deterministas y demo sin API key |
| [ADR-009](./adr/ADR-009-v2-regla-correa-demo.md) | V2: regla demo **validada** de correa + historial insuficiente | V2 sin regla de correa | El escenario EX-01 debe ejercitar `INSUFFICIENT_HISTORY`, no la ausencia de plan |
| [ADR-010](./adr/ADR-010-consentimiento-nomenclatura-y-suprimidos.md) | `MAINTENANCE_REMINDERS` como única finalidad de recordatorios; `consentEventId` nulo en mensajes suprimidos | Campo obligatorio | Un mensaje suprimido no tiene opt-in que referenciar |
| [ADR-011](./adr/ADR-011-procedencia-y-origen-sintetico.md) | `provenance` (quién respalda) ortogonal a `dataOrigin` (real/sintético) + prefijo `SYNTHETIC-DEMO:` | `SIMULATED` como valor de `provenance` | Un dato sintético puede simular cualquier procedencia; el rótulo debe ser inequívoco |
| [ADR-012](./adr/ADR-012-vencimiento-tecnico-vs-comunicacion.md) | Separar vencimiento técnico, política de comunicación y política de calidad de datos | Una sola `CommunicationPolicy` | Los umbrales comerciales nunca deben cambiar si un servicio está técnicamente vencido |
| [ADR-013](./adr/ADR-013-decisiones-fase-0-1.md) | Decisiones provisionales adoptadas para Fases 0–1 | — | Desbloquear la implementación con decisiones reversibles y documentadas |
| [ADR-014](./adr/ADR-014-persistencia-fase-2.md) | Persistencia de Fase 2: ajustes de esquema, invariantes SQL null-safe, append-only ampliado, verificación de migraciones en base desechable | Reset con Prisma | Integridad garantizada por la BD y migraciones reproducibles sin operaciones destructivas |
| [ADR-015](./adr/ADR-015-journey-fsm-idempotencia-contacto.md) | FSM declarativa pura; eventos idempotentes con bloqueo optimista; deduplicación de recordatorios por ciclo/política/ventana; outbox simplificado | XState; dedup por `inputHash` | Determinismo, auditoría y ausencia de duplicados ante reintentos y concurrencia |
| [ADR-016](./adr/ADR-016-minimo-privilegio-personal.md) | Asesor por cartera o caso asignado; compliance solo auditoría justificada o caso asignado; resolución solo por asignación | Acceso amplio por rol | Mínimo privilegio y Ley 1581 |
| [ADR-017](./adr/ADR-017-reservas-mock-y-seguridad.md) | Reservas con taller/CRM MOCK detrás de puertos y capa anticorrupción; token hasheado; confirmación humana en tres fases con reconciliación de resultados inciertos y compensación | Llamar al taller dentro de la transacción; confirmar ante timeout | AC06/AC09: nunca una reserva confirmada sin folio, sin duplicados y sin reintentos a ciegas |
| [ADR-018](./adr/ADR-018-agente-gateway-orquestacion.md) | Agente detrás de `LlmPort` (Anthropic o ScriptedLlm); catálogo de herramientas estable con control por estado en el gateway; contexto como mensaje system añadido; transcripción solo de añadido; preclasificador y validador de salida | Exponer solo herramientas permitidas al modelo; regenerar respuestas bloqueadas | Prefijo estable (preserved thinking), controles en código y demo reproducible sin API key |

---

## 12. Decisiones pendientes y supuestos que requieren validación

### 12.1 Decisiones pendientes (técnicas/producto)

| ID | Decisión | Opciones | Recomendación provisional | Quién valida |
|---|---|---|---|---|
| D-01 | Diferencia `DUE` vs `OVERDUE` (el PRD no la define) | (a) `DUE` = alcanzó el límite, `OVERDUE` = superó límite + gracia; (b) colapsar en `DUE` | **Adoptada provisional (ADR-012/013):** (a) con gracia 500 km / 30 días en `CommunicationPolicy`; `DUE` técnico no depende de la gracia | Producto + responsable técnico |
| D-02 | Valores de `leadKm`/`leadDays` | 1.000 km / 30 días (ejemplo PRD) | **Adoptada provisional (ADR-013):** 1.000 km / 30 días, política versionada | Producto/comercial |
| D-03 | Antigüedad máxima de odómetro antes de pedir confirmación | 15/30/60 días | **Adoptada provisional (ADR-013):** 30 días en `DataQualityPolicy` | Producto |
| D-04 | ¿El alistamiento de entrega (PDI) con cambio de aceite documentado sirve como línea base? | Sí si hay OT del taller / No | **Implementada (ADR-013):** solo si la regla lo permite (`allowDeliveryBaseline`); por defecto no | Responsable técnico + operación |
| D-05 | Aritmética de meses y zona horaria | `date-fns` + `@date-fns/tz` vs `Temporal` | **Implementada (ADR-013):** módulo propio sin dependencias (`Intl` + días epoch), clamp a fin de mes | Arquitectura |
| D-06 | Proyección de km por uso promedio | No / Sí con etiqueta «estimado» | No en MVP (evita «cifras inventadas»); P1 | Producto |
| D-07 | Implementación FSM | Tabla TS propia vs XState v5 | **Implementada (ADR-015):** tabla declarativa propia | Arquitectura |
| D-08 | Persistencia de mocks | Postgres (`Mock*`) vs memoria | Postgres | Arquitectura |
| D-09 | Cierre de taller en demo: ¿`SIMULATED` o `WORKSHOP_VERIFIED` con actor demo? | — | **Resuelta (ADR-011):** `WORKSHOP_VERIFIED` + `dataOrigin=SYNTHETIC` | Producto |
| D-10 | CRM/DMS/agenda reales de la agencia | — | Desconocido; puertos neutrales | Cliente (PRD §14.5) |
| D-11 | Mecanismo de sesión demo | iron-session / NextAuth Credentials / JWT | **Implementada (ADR-018):** cookie firmada HMAC propia, sin dependencias | Arquitectura |
| D-12 | Finalidades de consentimiento y si el uso del asistente IA requiere finalidad propia | — | Finalidad separada `AI_ASSISTANT_PROCESSING` | Jurídico (Ley 1581) |
| D-13 | Datos que se envían al LLM y transferencia internacional de datos | — | Minimización + pseudónimos; revisar transferencia internacional | Jurídico/seguridad |
| D-14 | Dependencias auxiliares: `fast-check`, `dependency-cruiser` | Incluir / no | **Implementada (ADR-013):** `fast-check`; fronteras con ESLint `no-restricted-imports` + test, sin `dependency-cruiser` | Arquitectura |
| D-15 | Postgres para tests | Docker Compose local vs Testcontainers vs Neon branch | **Implementada (ADR-013):** Docker Compose (puerto 54329) + BD `vehicle_care_test` | Arquitectura |
| D-16 | Evals con LLM real en CI | Siempre / manual / nightly | Manual + antes de demo | Arquitectura |
| D-17 | Playwright para AC13 (UI móvil/accesibilidad) | Incluir / revisión manual | Incluir 1 smoke + axe si hay tiempo | Arquitectura |
| D-18 | Modelo LLM | `claude-sonnet-5-5` vs `claude-haiku-5-5` vs `claude-opus-5-5` | **Implementada (ADR-018):** `claude-opus-5-5` por defecto, configurable (`LLM_MODEL`, `LLM_EFFORT`); `ScriptedLlm` sin API key | Arquitectura/coste |
| D-19 | Streaming de respuestas | Sí / No | **Implementada (ADR-018):** sin streaming en el MVP | Arquitectura |
| D-20 | Selección de taller | Usuario elige / taller por defecto según ubicación | Usuario elige entre 2 talleres seed | Producto |
| D-21 | Cancelación/reprogramación por el agente | P0 / P1 | P1 (en MVP vía asesor) | Producto |
| D-22 | Hosting y región de datos | Vercel + Postgres gestionado (región) | Definir región; impacta D-13 | Cliente/jurídico |
| D-29 | ¿Un servicio solo declarado por el propietario (sin documento) sirve como línea base? | Sí / No / Sí con etiqueta | **Adoptada provisional (ADR-013):** No → `UNKNOWN[BASELINE_NOT_DOCUMENTED]`; `PRIOR_OWNER_DOCUMENT` sí | Responsable técnico + producto |
| D-30 | Valores reales de intervalos por referencia de vehículo | — | Pendiente: solo de manuales/planes técnicos aprobados (PRD §14.1, §14.4); el MVP usa reglas `SYNTHETIC-DEMO` | Responsable técnico de la agencia |
| D-31 | Frecuencia de recordatorios | — | **Provisional (ADR-015):** separación mínima 14 días, máximo 2 por ciclo, configurable en `CommunicationPolicy` | Producto/comercial + jurídico |
| D-32 | SLA de casos de seguridad | — | **Provisional:** 30 minutos (`SAFETY_SLA_MINUTES`) | Operación de la agencia |
| D-33 | Reapertura de un journey `CLOSED` (journey único por vehículo+servicio) | Nuevo journey por ciclo / reapertura humana | Pendiente (P1) | Producto |
| D-34 | Alcance por agencia/sede y rol supervisor | — | Pendiente (ADR-016) | Cliente |
| D-36 | Intentos de reconciliación antes de escalar | — | **Provisional (ADR-017):** 3 intentos → caso `BOOKING_FAILURE` HIGH | Operación |
| D-37 | Gracia antes de dar por fallida una reserva «no encontrada» en un taller real | Ventana / webhook | Pendiente para integración real (el MOCK es síncrono) | Arquitectura + proveedor |
| D-38 | Tarifas reales y vigencia de cotización | — | Pendiente: el catálogo MOCK es sintético (48 h de vigencia) | Cliente (PRD §14.8) |
| D-39 | Almacén del limitador de tasa | Memoria / Redis / Postgres | Memoria (una instancia); P1: compartido | Arquitectura |
| D-40 | Reclamar el turno al inicio para evitar efectos de turnos concurrentes perdedores | — | Pendiente (P1); hoy el perdedor recibe 409 | Arquitectura |

### 12.2 Supuestos

| ID | Supuesto | Riesgo si es falso |
|---|---|---|
| A-01 | Un vehículo tiene un único propietario vigente; propietarios anteriores no ven datos nuevos | Fuga de datos entre titulares |
| A-02 | El catálogo del taller devuelve precio con desglose de IVA; nosotros **no** calculamos impuestos | Precios incorrectos mostrados |
| A-03 | Moneda COP sin decimales (enteros) | Errores de redondeo |
| A-04 | El odómetro siempre es en km | Conversión millas en importados |
| A-05 | Un plan técnico se identifica por marca/modelo/año/motor/mercado; VIN no es suficiente por sí mismo | Plan equivocado → recomendación errónea |
| A-06 | Las respuestas de seguridad (EX-02) son textos fijos aprobados por personal cualificado; en la demo son borradores rotulados | Responsabilidad legal |
| A-07 | Los cupos del taller son por franja y tipo de servicio con capacidad entera | Modelo de agenda distinto (por bahía/técnico) |
| A-08 | La cotización tiene vigencia (`validUntil`) y el taller la honra al reservar | Reclamos por precio |
| A-09 | Español de Colombia como único idioma de UI y del agente | — |
| A-10 | Los vehículos seed, sus planes y políticas son sintéticos (`dataOrigin=SYNTHETIC`, fuente `SYNTHETIC-DEMO:`), no recomendaciones reales; la marca es ficticia («DemoMotors») | Que se confundan con datos reales |
