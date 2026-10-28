# Informe — Fase 5 (MaintenanceAdvisor, Tool Gateway y orquestación agéntica)

**Fecha:** 2026-10-28 · **Alcance:** solo Fase 5. Sin UI (Fase 6), sin WhatsApp, CRM ni talleres reales, sin SOAT/seguros/RUNT. El Maintenance Engine no se modificó.

> **Sobre el LLM de esta evidencia.** Todos los recorridos y tests usan `ScriptedLlm`: **simulación determinista por reglas, no IA generativa**. Así se rotula en la API (`assistant.simulated=true`), en las trazas y en la evidencia. El adaptador real `AnthropicLlm` (SDK oficial) está implementado y su solicitud HTTP se verificó con un transporte simulado, pero **no se llamó a la API de Anthropic** en esta fase (no hay API key en el entorno).

## 1. Validación (comandos ejecutados sobre el código final)

| Comando | Resultado real |
|---|---|
| `pnpm lint` | exit 0, 0 errores y 0 warnings |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (unitarios) | exit 0 — **13 archivos, 180 tests** (152 previos + 28 nuevos) |
| `pnpm test:integration` | exit 0 — **11 archivos, 160 tests** (127 previos + 33 nuevos) |
| `pnpm test:journeys` | exit 0 — **13 tests** (E2E-01…05 + adversariales + sesión y concurrencia) |
| `pnpm test:coverage` (`src/domain`) | 99,8 % stmts · 97,2 % ramas · 100 % funciones · 100 % líneas |
| Cobertura combinada unit + integración | `src/agent`: 94,1 % líneas · 79,7 % ramas; `src/application`: 93,3 % líneas · 75,9 % ramas |
| `pnpm build` | exit 0; rutas dinámicas `ƒ /api/agent/turn`, `ƒ /api/bookings/confirm`, `ƒ /api/demo/session` |
| `pnpm db:verify-migrations` | 10 migraciones desde una base vacía → «No difference detected» → seed → base eliminada |
| API real (`next start`) | sin sesión 401; sesión demo 200 (rotulada «Sesión simulada»); turno 200 con tarjeta `EVALUATION`; acceso cruzado 403 |
| `pnpm demo:agent-journeys` | 4 recorridos vía API → `prd/reports/evidence/agent-journeys.json` (3 tokens redactados, 0 en claro) |

## 2. Evidencia de los cuatro recorridos (`pnpm demo:agent-journeys`, base desechable)

| Recorrido | Herramientas ejecutadas y datos devueltos | Resultado |
|---|---|---|
| **A) Éxito** (V1, C1) | `evaluateMaintenance` → UPCOMING, plan `demo-2026.10-r1` · `listWorkshops` → 2 talleres · `getQuote` (MOCK) → 333.200 COP · `getAvailableSlots` (MOCK) → 4 horarios · `prepareBooking` (MOCK) → intención que expira en 10 min · **clic del propietario** `POST /api/bookings/confirm` → `CONFIRMED`, folio `FOLIO-T1-DEMO-…` | `BOOKED` |
| **B) Historial insuficiente** (V2 correa, C2) | `evaluateMaintenance` → `UNKNOWN [INSUFFICIENT_HISTORY]` sin cifras · `createHumanCase(INSUFFICIENT_HISTORY)` asignado al asesor | `HUMAN_REVIEW`; el texto no recomienda el cambio ni afirma que está al día |
| **C) Seguridad** (V3, C3) | Preclasificador `BRAKES` → caso URGENT **sin llamar al LLM**, con plantilla del servidor · luego «cotízame» → `listWorkshops` → `TOOL_NOT_ALLOWED_IN_STATE` | `SAFETY_ESCALATED`; 0 cotizaciones |
| **D) Conflicto de cupo** (V2 aceite, C2) | Flujo hasta la intención · escenario MOCK `SLOT_CONFLICT_ON_NEXT_BOOKING` · clic → 409 `SLOT_CONFLICT` · «¿otros horarios?» → `getAvailableSlots` · «reserva el segundo» → nueva intención · clic → `CONFIRMED` | Reservas de V2: 1 `FAILED(SLOT_CONFLICT)` + 1 `CONFIRMED`; **1 sola** reserva en el taller MOCK |

## 3. Archivos

**Agente** (`src/agent/`):
- `maintenance-advisor.ts` (orquestador), `gateway.ts` (Tool Gateway), `tools/definitions.ts` (Zod).
- `llm/types.ts`, `llm/anthropic-llm.ts`, `llm/scripted-llm.ts` (`ScriptedLlm` + `SequenceLlm`).
- `safety/lexicon.ts`, `safety/injection.ts`, `output-guard.ts`, `cards.ts`, `memory.ts`, `prompts/advisor-v1.ts`.

**API e infraestructura:**
- `src/infra/container.ts` (composición y configuración por entorno), `src/infra/session.ts`, `src/infra/rate-limit.ts`, `src/infra/http/handlers.ts`.
- Rutas `src/app/api/{agent/turn,bookings/confirm,demo/session}/route.ts`.

**Aplicación y dominio (mínimos):**
- Nuevo caso de uso `getMaintenancePlan`.
- `decideProcessingConsent` (consentimiento para procesar con IA).
- FSM: `OWNER_OPENED` también desde `ACTIVATED`.
- `selectPlanVersion` exportado; códigos de error `PLAN_NOT_VERIFIED` y `CONSENT_REQUIRED`.

**Migración:** `20261028230000_phase5_agent_sessions`:
- `ConversationSession` con `transcript`, `customerId`, `serviceCode`, `turnCount` y `status`;
- CHECKs;
- trigger de **transcripción solo de añadido** (la versión anterior debe ser prefijo exacto);
- `ConversationMessage` inmutable.

**Tests:**
- Unitarios: `src/agent/__tests__/{safety-and-guard,tools-llm-memory}.test.ts`, `src/infra/__tests__/session-rate-limit.test.ts`.
- Integración: `tests/integration/{gateway,agent-journeys,api}.integration.test.ts`, helper `helpers/agent.ts`.

**Scripts:** `scripts/demo-agent-journeys.ts` (`pnpm demo:agent-journeys`) y `pnpm test:journeys`.

**Dependencias:** `@anthropic-ai/sdk` 1.3.0 y `zod` 4.6.7.

**Docs:** ADR-018, `prd/PHASE6_HANDOFF.md`, ARCHITECTURE (ADR, D-11/18/19 resueltas, D-39/40), AGENT_DESIGN (nota de implementación, D-18/27), DATA_MODEL, IMPLEMENTATION_PLAN, README y `.env.example`.

## 4. Decisiones clave (ADR-018)

- **Modelo:** `LLM_PROVIDER=scripted` por defecto. Con `anthropic`: `claude-opus-5-5` (configurable), esfuerzo `medium`, sin `temperature`, `tool_choice: auto`, herramientas `strict: true` y **fallback de rechazo del lado del servidor activado por defecto** (`LLM_SERVER_FALLBACKS=false` lo apaga).
- **Prefijo estable para *preserved thinking*:**
  - system prompt estático;
  - **catálogo completo y fijo de herramientas**, con control por estado en el gateway;
  - contexto por turno en un mensaje `role: "system"` añadido;
  - transcripción solo de añadido (trigger) con bloqueo optimista por turno;
  - bloques de pensamiento reenviados intactos.
- **Gateway** (en este orden): límite de llamadas → catálogo → esquema estricto → estado → consentimiento IA → idempotencia → caso de uso (reautoriza) → `ToolCall` pseudonimizado → proyección al modelo sin PII.
  - **El token de confirmación nunca llega al modelo** ni se persiste.
  - **No existe herramienta de confirmación.**
- **Guardrails:** preclasificador de seguridad antes del LLM; detector de inyección que solo marca; validador de salida contra datos estructurados que, si algo falla, devuelve un texto de respaldo sin regenerar; tarjetas generadas solo desde resultados estructurados.
- **API:** sesión firmada con HMAC, solo `OWNER`, cuerpo estricto de hasta 8 KB, límite de tasa, `no-store`, `x-trace-id` y errores recuperables en la respuesta.

## 5. Cobertura de pruebas pedidas

| Grupo | Tests |
|---|---|
| **GW-01…GW-10** | vehículo/campos extra → `INVALID_INPUT`; herramienta fuera de estado (registrada); acceso cruzado → `UNAUTHORIZED`; mutación repetida → un efecto; seguridad forzada a URGENT; cupo inexistente/cotización ajena; reserva activa; taller caído tipado sin detalles internos; `ToolCall` con traza, HMAC, duración y fuente; sin PII ni tokens en registros ni en lo que ve el modelo. Además: `UNKNOWN_TOOL` (confirmBooking, completeWorkOrder), `TOOL_CALL_LIMIT`, consentimiento IA |
| **SG-01…SG-06** | frenos (ejemplo del PRD), dirección, humo/combustible, temperatura/testigos/llantas/líquido; negativos comerciales; plantilla sin diagnóstico; ruta sin LLM (E2E-03, con un LLM que falla si se le llama) |
| **OG-01…OG-06** | precio inventado; intervalo inventado y periodos; reserva o folio falsos; montos válidos en varios formatos; «al día» con UNKNOWN, certificación y diagnóstico; números del propietario; fechas ISO/dd/mm/aaaa y folio real |
| **E2E-01…05** | §2 (A–D) + E2E-05: sin consentimiento de recordatorios no hay campaña, pero sí consulta voluntaria |
| **Adversariales** | modelo que «confirma» y afirma la reserva (bloqueado, 0 reservas); precio alucinado (bloqueado y marcado); vehículo ajeno y herramienta fuera de estado (rechazados, el modelo recibe errores); inyección y datos de terceros (marcados, sin fuga ni efectos); rechazo, caída del LLM y límite de iteraciones (respuestas seguras, transcripción válida) |
| **Sesión y API** | sin consentimiento IA no se llama al LLM ni se guarda el mensaje; sesión ajena u otro rol rechazados; turnos concurrentes → uno 409 y la transcripción solo crece; 401/403/400/413/415/429; confirmación por clic (ajeno 403, duplicado idempotente, token inválido 404); sesión demo solo con `DEMO_MODE` |
| **Adaptador real** | con `fetch` inyectado: modelo y esfuerzo, `strict`, `tool_choice auto`, `fallbacks: "default"` + beta, sin `temperature`/`thinking`, mensaje `system` añadido, bloques de pensamiento opacos y conteo de tokens |

## 6. Errores encontrados durante la ejecución

1. **El agente no avanzaba tras explicar la recomendación.** El gateway omitía `EVALUATED` como redundante (lógica del job), así que `RECOMMENDATION_SHOWN` no encontraba la evaluación vigente. Detectado con un smoke test; en conversación ahora se registra siempre, de forma idempotente.
2. **Bug del léxico:** «casi no frena» no se detectaba (exigía un espacio tras el verbo). Detectado por SG-01 y corregido.
3. **Consentimiento solo en el orquestador:** el gateway no lo comprobaba por sí mismo. Añadido (el requisito pide aplicarlo en el gateway).
4. **Build:** `runtime` y `dynamic` en las rutas son incompatibles con `cacheComponents` (Next 16). Eliminados; las rutas `POST` siguen siendo dinámicas.
5. **Variable `path` en zsh:** al reasignarla en un script se rompió `PATH`. Repetido con otro nombre; sin impacto en el código.
6. **Presentación:** la plantilla de seguridad aparecía en el harness como «ScriptedLlm», y el texto de `DUE` podía sugerir que la fecha límite ya había pasado. Corregidos.

## 7. Riesgos pendientes

- **Sin prueba con LLM real.** La calidad conversacional, el cumplimiento del prompt y los costos con `claude-opus-5-5` no están medidos. Antes de la demo: eval EV-01…EV-25 (Fase 7) con API key y presupuesto aprobados.
- **Esquemas estrictos:** se omiten las palabras clave de rango por precaución, pero la aceptación del esquema por la API real no está comprobada.
- **`ScriptedLlm` es por palabras clave:** frases fuera de sus reglas reciben una respuesta genérica. No debe presentarse como comprensión de lenguaje.
- **Limitador en memoria** (D-39): no sirve con varias instancias o serverless.
- **Turnos concurrentes** (D-40): el perdedor recibe 409 pero pudo ejecutar herramientas idempotentes.
- **El validador de salida es heurístico:** podría bloquear textos legítimos (falsos positivos) o no reconocer formatos numéricos inusuales. Faltan medición con LLM real y ajuste.
- **Contenido de seguridad:** léxico y plantilla provisionales (D-24, D-25), sin validación de personal técnico. No hay número de asistencia real.
- **Datos en la transcripción:** guarda el texto del propietario (necesario para continuidad). Falta definir retención y anonimización (DATA_MODEL §6).
- **Sesión demo:** sin OTP ni SSO reales; `SESSION_SECRET` de desarrollo en `.env.example`, que no debe usarse fuera de local.
- **Transferencia de datos al proveedor LLM** (D-13): se minimiza (sin placa, contacto ni identificadores del cliente), pero falta la revisión jurídica.

## 8. Para la Fase 6

Endpoints, contrato de `TurnResult`, tarjetas, rótulos obligatorios y endpoints que faltan: **`prd/PHASE6_HANDOFF.md`**.
