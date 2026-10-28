# Vehicle Care — Plan de implementación incremental

**Versión:** 0.1 · **Fecha:** 28-oct-2026 · Base: [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`DATA_MODEL.md`](./DATA_MODEL.md), [`AGENT_DESIGN.md`](./AGENT_DESIGN.md)

Principios: **vertical slices** que siempre dejan la demo en estado funcional; **TDD en el dominio puro** (motor, FSM, políticas) antes de UI; cada fase cierra con criterios verificables y tests en verde. Presupuesto orientado a la ventana de 24 h de la prueba; las fases 0–6 son el MVP y las 7–8 son endurecimiento.

---

## 0. Puerta previa: decisiones a cerrar antes de codificar

Bloqueantes para la fase 1–2 (se pueden tomar las recomendaciones provisionales y documentarlas como ADR):

- **D-01** `DUE` vs `OVERDUE` · **D-02/D-03** umbrales de comunicación y antigüedad de odómetro · **D-04** línea base de alistamiento · **D-05** librería de fechas.
- **D-07** FSM propia vs XState · **D-08** mocks en Postgres · **D-11** sesión demo · **D-15** Postgres para tests · **D-18** modelo LLM.

Sin bloqueo inmediato (pueden resolverse en paralelo): D-12/D-13 (jurídico), D-24/D-25 (contenido de seguridad), D-10/D-22 (sistemas e infraestructura del cliente).

---

## 1. Fases

### Fase 0 — Scaffold y calidad base (≈1 h) · ✅ implementada 28-oct-2026

- Next.js (App Router) + TypeScript `strict`, ESLint, Prettier, Vitest (proyectos `unit`, `integration`, `evals`), Zod, Prisma + PostgreSQL vía Docker Compose, `prisma.config.ts`.
- `infra/clock.ts`, `infra/ids.ts`, `domain/shared/result.ts`, logger estructurado.
- Reglas de frontera (`dependency-cruiser`) para `domain/**`.
- **Hecho cuando:** `pnpm test` y `pnpm lint` en verde con un test trivial; se aplica una migración base vacía (`prisma migrate deploy`; `migrate dev` no genera migraciones sin cambios de esquema).

### Fase 1 — Maintenance Engine puro (≈2.5 h) · AC02, AC03 · ✅ implementada 28-oct-2026

- `domain/maintenance-engine`: tipos, `evaluate()`, `ReasonCode`, aritmética de fechas en `America/Bogota`, `decisionTrace`, `inputHash`.
- Tests table-driven (§4.1) + propiedades con `fast-check`.
- **Hecho cuando:** ME-01…ME-26 y ME-P1…P4 en verde; cobertura de ramas ≥ 95 % en el módulo; cero imports fuera de `domain/`.

### Fase 2 — Modelo de datos, seed y casos de uso de lectura (≈2.5 h) · AC01, AC11 · ✅ implementada 28-oct-2026 (pendiente de revisión)

- `schema.prisma` completo, migración SQL manual de invariantes (índices parciales, `CHECK`, triggers append-only).
- `seed.ts` con V1–V4, C1–C3, T1–T2, cupos, planes demo, `CommunicationPolicy v1`.
- `EvaluationContextBuilder` + `evaluate-vehicle` (persiste `MaintenanceEvaluation`).
- `access-policy`, `consent-policy` (puras + tests).
- **Hecho cuando:** integración IT-01…IT-06 en verde; evaluación de V1 reproduce el ejemplo del PRD desde BD.

### Fase 3 — Máquina de estados y eventos (≈1.5 h) · ✅ implementada 28-oct-2026 (pendiente de revisión; incluye P0 de Fase 2: deduplicación de recordatorios, mínimo privilegio, IT-05 completo)

- `domain/journey`: estados, eventos, tabla de transiciones, guardas, herramientas permitidas por estado.
- Repositorio con bloqueo optimista y `JourneyEvent` append-only.
- **Hecho cuando:** FSM-01…FSM-12 en verde; transición inválida devuelve `INVALID_TRANSITION`.

### Fase 4 — Puertos, mocks e integración taller/CRM (≈2 h) · AC09, AC14

- `integrations/ports/*`, adaptadores mock sobre tablas `Mock*`, `FaultInjector`, capa anticorrupción.
- Casos de uso: `request-quote`, `list-slots`, `prepare-booking`, `confirm-booking` (idempotente), `open-human-case`, `record-odometer`, `complete-work-order`.
- **Hecho cuando:** IT-07…IT-16 en verde (incluida concurrencia de cupo y doble confirmación).

### Fase 5 — Agente: gateway, herramientas, orquestador (≈3 h) · AC04, AC05, AC06, AC07, AC08

- `agent/tools/*` (Zod → JSON Schema), `gateway.ts`, `orchestrator.ts`, `LlmPort` + `AnthropicLlm` + `ScriptedLlm`.
- `safety/lexicon.ts` + plantilla, `output-guard.ts`, memoria estructurada, prompt `advisor-v1`.
- `POST /api/agent/turn`, `POST /api/bookings/confirm`.
- **Hecho cuando:** GW-01…GW-10, SG-01…SG-06, OG-01…OG-06 y journeys E2E-01…E2E-05 (con `ScriptedLlm`) en verde.

### Fase 6 — UI del journey y paneles (≈4 h) · AC01, AC04, AC12, AC13

- Selector de persona demo (rotulado), ficha del vehículo, tarjeta de plan/evaluación con fuente y versión, chat con tarjetas (cotización, cupos, confirmación, folio, caso).
- Panel «qué hizo el agente» por `trace_id`; vista de estado del journey y actor responsable.
- Bandeja de casos (asesor) y consola de taller con «SIMULACIÓN — cierre de taller».
- Rótulos `MOCK`/`SIMULADO` en todos los datos sintéticos; responsive y accesible (labels, foco, contraste, `aria-live` en chat).
- **Hecho cuando:** recorrido manual de los 5 journeys en móvil y escritorio; smoke Playwright opcional **[D-17]**.

### Fase 7 — Evals y endurecimiento (≈2 h) · PRD §10

- Suite `tests/evals` (EV-01…EV-25) con LLM real; informe en `docs/evals-report.md`.
- Rate limit en endpoints de agente y confirmación; redacción de logs; revisión de mensajes de error.
- **Hecho cuando:** críticos sin fallos; resto ≥ 90 % y fallos documentados.

### Fase 8 — Documentación de entrega (≈1 h) · AC14

- `docs/MOCKS_AND_PRODUCTION.md` (qué es mock y qué requiere producción), README de ejecución, declaración de uso de IA, checklist DoD con evidencia (capturas).

> Total estimado ≈ 19–20 h; margen ≈ 4 h para imprevistos. Si el tiempo aprieta, recortar en este orden: Playwright → V4 → EV no críticos → consola de taller (sustituir por botón en panel ops).

---

## 2. Trazabilidad criterio de aceptación → fase → prueba

| AC | Fase | Evidencia |
|---|---|---|
| AC01 elegir vehículo y ver perfil | 2, 6 | IT-02, recorrido UI |
| AC02 estado, motivo, unidad, regla, `plan_version` | 1, 6 | ME-01…ME-08, UI tarjeta |
| AC03 `UNKNOWN` sin intervalo inventado | 1 | ME-09…ME-16, EV-05, OG-02 |
| AC04 UI muestra qué consultó | 5, 6 | GW-09, panel trazas |
| AC05 solo precios del catálogo | 4, 5 | OG-01, EV-13 |
| AC06 reserva solo tras aprobación y éxito | 4, 5 | IT-10, E2E-01, EV-20 |
| AC07 historial incierto → caso humano | 5 | E2E-02, EV-04 |
| AC08 seguridad interrumpe journey | 3, 5 | FSM-08, E2E-03, EV-07/08 |
| AC09 conflicto de cupo sin duplicados | 4 | IT-11, IT-12, E2E-04 |
| AC10 sin consentimiento no hay campaña | 2, 4 | IT-05, E2E-05 |
| AC11 procedencia en historial | 2, 6 | IT-03, UI |
| AC12 trazas, estado y actor | 3, 6 | panel ops |
| AC13 móvil/escritorio accesible | 6 | revisión manual + axe |
| AC14 mocks documentados | 8 | `docs/MOCKS_AND_PRODUCTION.md` |

---

## 3. Riesgos del plan

| Riesgo | Mitigación |
|---|---|
| Latencia/variabilidad del LLM en demo | `ScriptedLlm` como modo de respaldo rotulado; temperatura baja |
| Aritmética de fechas con bordes (fin de mes, bisiestos) | Tests explícitos ME-17…ME-20 |
| Carreras en cupos/confirmación | Transacciones + `UPDATE ... WHERE remaining > 0` + idempotencia; IT-11/12 |
| El output guard bloquea respuestas legítimas | Tests OG con positivos y negativos; respaldo determinista |
| Alcance de UI excede tiempo | Componentes simples (shadcn/ui o Tailwind plano); priorizar journey sobre estética |

---

## 4. Catálogo de casos de prueba

Convención: fecha de referencia `now = 2026-10-28T12:00:00-05:00`, `CommunicationPolicy demo-comm-v1 = { leadKm: 1000, leadDays: 30, overdueGraceKm: 500, overdueGraceDays: 30 }` y `DataQualityPolicy demo-dq-v1 = { maxOdometerAgeDays: 30 }` (valores provisionales **[D-01..D-03]**, ADR-012). Regla base sintética: aceite+filtro 5.000 km / 12 meses (`SYNTHETIC-DEMO`). En la columna «Esperado», el estado es el consolidado; el técnico se indica cuando difiere.

### 4.1 Maintenance Engine (unit, Vitest)

| ID | Entrada (resumen) | Esperado |
|---|---|---|
| ME-01 | Ejemplo PRD: último 70.000 km @2026-04-01; odo 74.200 @2026-10-28 | `UPCOMING`, `dueBy.km=75000`, `date=2027-04-01`, `trigger=KM`, `remaining.km=800` |
| ME-02 | odo 72.000 | `NOT_DUE` |
| ME-03 | odo 75.000 exacto | `DUE` (límite alcanzado, incl.) |
| ME-04 | odo 75.499 | `DUE` |
| ME-05 | odo 75.500 | `OVERDUE` (gracia 500 incl.); técnico sigue `DUE` |
| ME-06 | Por tiempo: último @2025-11-15, km bajos | `UPCOMING`, `trigger=TIME` |
| ME-07 | Por tiempo: último @2025-10-28 | `DUE`, `trigger=TIME` |
| ME-08 | KM `UPCOMING` y TIEMPO `DUE` | `DUE` (gana el peor), `trigger=TIME` |
| ME-09 | Plan `null` | `UNKNOWN[PLAN_MISSING]`, `dueBy=null` |
| ME-10 | Plan `DRAFT` | `UNKNOWN[PLAN_NOT_VERIFIED]` |
| ME-11 | `engineCode=null` | `UNKNOWN[ENGINE_UNIDENTIFIED]` |
| ME-12 | Sin regla para el `serviceCode` | `UNKNOWN[RULE_MISSING_FOR_SERVICE]` |
| ME-13 | Sin `lastService` | `UNKNOWN[INSUFFICIENT_HISTORY]` (13b alistamiento no permitido, 13c permitido, 13d solo declarado → `BASELINE_NOT_DOCUMENTED`) |
| ME-14 | Regla exige condición de uso y es `null` | `UNKNOWN[USAGE_CONDITION_REQUIRED]` |
| ME-15 | `lastService.odometerKm > odometer.valueKm` | `UNKNOWN[CONTRADICTORY_RECORDS]` |
| ME-16 | Historial de odómetro decreciente | `UNKNOWN[CONTRADICTORY_RECORDS]` |
| ME-17 | `addMonths` 2026-01-31 + 1 | 2026-02-28 |
| ME-18 | Año bisiesto: 2028-02-29 + 12 meses | 2029-02-28 |
| ME-19 | Servicio el día exacto del límite de tiempo en Bogotá vs UTC | Vence en fecha local, sin desfase de 1 día |
| ME-20 | `observedAt` en el futuro | `UNKNOWN[CONTRADICTORY_RECORDS]` |
| ME-21 | Correa: vehículo `CHAIN` | `NOT_APPLICABLE` |
| ME-22 | Correa: `timingDrive=UNKNOWN` | `UNKNOWN[TIMING_DRIVE_UNKNOWN]` |
| ME-23 | V2 correa: `BELT`, regla demo **validada**, 95.000 km, sin constancia (EX-01, ADR-009) | `UNKNOWN[INSUFFICIENT_HISTORY]`, `suggestedAction=HUMAN_REVIEW` |
| ME-24 | Odómetro de hace 60 días que da `NOT_DUE`; tiempo `NOT_DUE` | `UNKNOWN[ODOMETER_STALE]`, `requiresOdometerConfirmation=true`, `CONFIRM_ODOMETER` |
| ME-25 | Odómetro de hace 60 días que ya da `DUE` | `DUE` (cota inferior concluyente), `requiresOdometerConfirmation=true` |
| ME-26 | Solo `intervalKm` (sin meses) | Evalúa solo KM; `dueBy.date=null` |
| ME-P1 | Propiedad: determinismo | `evaluate(x)` ≡ `evaluate(x)`; mismo `inputHash` |
| ME-P2 | Propiedad: monotonicidad en km y tiempo | más km/tiempo ⇒ estado ≥ anterior |
| ME-P3 | Propiedad: `UNKNOWN` ⇒ `dueBy=null` y `remaining=null` | siempre |
| ME-P4 | Propiedad: cualquier `CommunicationPolicy` deja idéntico el resultado técnico (ADR-012) | siempre |

### 4.2 Máquina de estados (unit)

| ID | Caso | Esperado |
|---|---|---|
| FSM-01 | `ACTIVATED` + `EVALUATED(UPCOMING)` | `NEED_DETECTED` |
| FSM-02 | `NEED_DETECTED` + `CONTACT_SUPPRESSED` | `CONTACT_SUPPRESSED` |
| FSM-03 | `CONVERSATION_OPEN` + `EVALUATED(requiresOdometerConfirmation)` | `AWAITING_CONTEXT` |
| FSM-04 | `RECOMMENDATION_PRESENTED` + `QUOTE_UNAVAILABLE` | `QUOTE_PENDING_HUMAN` |
| FSM-05 | `AWAITING_CONFIRMATION` + `BOOKING_CONFIRMED` sin folio | rechazo `INVALID_TRANSITION` |
| FSM-06 | `AWAITING_CONFIRMATION` + `BOOKING_FAILED(SLOT_CONFLICT)` | `SLOT_SELECTION` |
| FSM-07 | `AWAITING_CONFIRMATION` + `BOOKING_FAILED(QUOTE_EXPIRED)` | `RECOMMENDATION_PRESENTED` |
| FSM-08 | Cualquier estado no terminal + `SAFETY_SIGNAL` | `SAFETY_ESCALATED` |
| FSM-09 | `SAFETY_ESCALATED` + `CASE_RESOLVED` por `SYSTEM_AGENT` | rechazo |
| FSM-10 | `SAFETY_ESCALATED` + `CASE_RESOLVED(clearedForService)` por `ADVISOR` | `CONVERSATION_OPEN` |
| FSM-11 | `IN_SERVICE` + `WORK_ORDER_COMPLETED` por `OWNER` | rechazo |
| FSM-12 | `allowedTools(SAFETY_ESCALATED)` | no incluye `getQuote/getAvailableSlots/prepareBooking` |

### 4.3 Integración (Vitest + Postgres)

| ID | Caso | Esperado |
|---|---|---|
| IT-01 | Seed aplicado | 4 vehículos, 3 clientes, 2 talleres, `CommunicationPolicy` activa única |
| IT-02 | `getVehicleProfile` de V1 por su titular | Perfil sin placa completa ni PII |
| IT-03 | Historial V1 | Distingue `provenance` (`WORKSHOP_VERIFIED`, `OWNER_DECLARED`) y `dataOrigin=SYNTHETIC` con `syntheticSourceRef` |
| IT-04 | Actor C2 lee V1 | `UNAUTHORIZED` |
| IT-05 | Job de evaluación con C2 (sin `MAINTENANCE_REMINDERS`) | `OutboundMessage.status=SUPPRESSED`, `consentEventId=null`, `suppressionReason=CONSENT_REQUIRED`; transición `CONTACT_SUPPRESSED` del journey → **Fase 3** (requiere la FSM) — ✅ completado en Fase 3 |
| IT-06 | `UPDATE` sobre `JourneyEvent` | Excepción del trigger |
| IT-07 | `getQuote` V1 en T1 | `Quote ACTIVE` con montos del mock, `source=MOCK` |
| IT-08 | `getQuote` con escenario `QUOTE_UNAVAILABLE` | `Quote UNAVAILABLE`; sin montos |
| IT-09 | `listSlots` sin cupos | `NO_SLOTS` |
| IT-10 | `confirmBooking` válido | `Booking CONFIRMED` con folio; `MockSlot.remaining` −1 |
| IT-11 | Dos confirmaciones concurrentes sobre cupo `capacity=1` (intents distintos) | 1 `CONFIRMED`, 1 `FAILED(SLOT_CONFLICT)` |
| IT-12 | Misma confirmación dos veces (misma idempotency key) | 1 reserva; respuestas idénticas |
| IT-13 | Misma key con payload distinto | `IDEMPOTENCY_MISMATCH` |
| IT-14 | Confirmar con cotización vencida (reloj adelantado) | `QUOTE_EXPIRED`; sin reserva |
| IT-15 | `recordOdometer` menor que lectura verificada | `ODOMETER_ROLLBACK` |
| IT-16 | `completeWorkOrder` por taller | `ServiceRecord` + `OdometerReading` verificados; re-evaluación `NOT_DUE` |

### 4.4 Gateway, seguridad y output guard (unit)

| ID | Caso | Esperado |
|---|---|---|
| GW-01 | Input con campo extra `vehicleId` | `INVALID_INPUT` (schema `.strict()`) |
| GW-02 | Herramienta no permitida en estado | `TOOL_NOT_ALLOWED_IN_STATE`; `ToolCall` registrado |
| GW-03 | Sin titularidad vigente | `UNAUTHORIZED` |
| GW-04 | Mutación repetida mismo turno | 1 efecto |
| GW-05 | `createHumanCase(SAFETY_ESCALATION, NORMAL)` | prioridad forzada `URGENT` + `SAFETY_SIGNAL` |
| GW-06 | `slotId` de otra sesión | `INVALID_INPUT` |
| GW-07 | `prepareBooking` con reserva activa | `ACTIVE_BOOKING_EXISTS` |
| GW-08 | Error de adaptador inesperado | `INTERNAL_ERROR`, sin stack en `userSafeMessage` |
| GW-09 | Cada llamada | `ToolCall` con `traceId`, `vehicleIdHash`, `durationMs`, `source` |
| GW-10 | Input redactado | sin email/teléfono/documento en `inputRedacted` |
| SG-01…04 | Frases de frenos, dirección, humo/olor a gasolina, temperatura (con/sin tildes, mayúsculas) | `hit=true` |
| SG-05 | «¿Cuánto cuesta cambiar las pastillas de freno?» | `hit=false` **[D-24: confirmar criterio]** |
| SG-06 | Ruta de seguridad | caso `URGENT`, mensaje `SYSTEM_NOTICE` de plantilla, sin llamada al LLM |
| OG-01 | Texto con «$350.000» sin quote | reemplazado por «cotización pendiente», flag `OUTPUT_BLOCKED` |
| OG-02 | Texto con «cada 10.000 km» con evaluación `UNKNOWN` | bloqueado |
| OG-03 | «Su cita quedó reservada» sin booking | bloqueado |
| OG-04 | Monto igual a `totalCop` de quote vigente | permitido |
| OG-05 | «Está al día» con `UNKNOWN` | bloqueado |
| OG-06 | Km que el usuario acaba de declarar | permitido |

### 4.5 Journeys end-to-end a nivel API (Vitest + `ScriptedLlm`)

| ID | Journey | Pasos y aserciones |
|---|---|---|
| E2E-01 | Éxito (V1/C1) | job → `NEED_DETECTED` → abrir chat → evaluación `UPCOMING` con fuente → quote → slots → intent → confirm → `BOOKED` con folio → taller completa (simulado) → `FOLLOW_UP` → re-evaluación |
| E2E-02 | EX-01 historial insuficiente (V2) | evaluación correa `UNKNOWN` → caso `INSUFFICIENT_HISTORY` → `HUMAN_REVIEW`; ningún texto recomienda cambio ni «al día» |
| E2E-03 | EX-02 seguridad (V3) | en `QUOTE_PRESENTED` el usuario reporta freno → `SAFETY_ESCALATED`, caso `URGENT`, intent previo invalidado, confirm devuelve error |
| E2E-04 | EX-03 cupo desaparecido (V1 + `SLOT_CONFLICT_ON_NEXT_BOOKING`) | confirm → `SLOT_CONFLICT`, ninguna reserva, `SLOT_SELECTION`, nuevo cupo → éxito; total reservas = 1 |
| E2E-05 | EX-04 sin consentimiento (C2) | job no envía mensaje; tarjeta en portal; consulta voluntaria funciona; preferencias accesibles |

---

## 5. Excepciones cubiertas (resumen)

| Excepción | Origen | Detección | Recuperación | Pruebas |
|---|---|---|---|---|
| EX-01 Historial insuficiente | PRD §9 | Motor `UNKNOWN` | Explicar incertidumbre, inspección, caso humano | ME-13, ME-23, E2E-02, EV-04 |
| EX-02 Riesgo de seguridad | PRD §9 | Lexicon + herramienta LLM | Plantilla aprobada, caso `URGENT`, bloqueo comercial | SG-*, FSM-08/09, E2E-03, EV-07/08 |
| EX-03 Cupo desaparecido | PRD §9 | `SLOT_CONFLICT` del taller | Nuevos cupos o asesor; idempotencia | IT-11/12, E2E-04, EV-10/11 |
| EX-04 Sin consentimiento | PRD §9 | `consent-policy` | Solo portal; gestión de preferencias | IT-05, E2E-05, EV-16 |
| Cotización no disponible | Diseño | `QUOTE_UNAVAILABLE` | «Cotización pendiente» + caso | IT-08, EV-13 |
| Cotización vencida | PRD §8.1 | `validUntil` | Recotizar | IT-14, EV-12 |
| Odómetro antiguo / retroceso | Diseño | Motor / `record-odometer` | Pedir confirmación / rechazar y escalar | ME-24/25, IT-15, EV-02/03 |
| Plan no verificado / motor no identificado | PRD §7 | Motor gates | «Pendiente de verificar» + caso | ME-09…11, EV-05/06 |
| Taller caído | PRD §8.1 | `WORKSHOP_UNAVAILABLE` | Reintento o asesor | EV-15 |
| Acceso a datos de terceros / inyección | PRD §10 | Authz + contexto inyectado | Rechazo, registro | IT-04, GW-01/03, EV-17…19, EV-23 |
