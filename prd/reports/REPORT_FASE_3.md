# Informe — Fase 3 (journey FSM, concurrencia, idempotencia, contacto, privilegios y seguridad)

**Fecha:** 2026-10-28 · **Alcance:** solo Fase 3 + correcciones P0 de Fase 2. Fases 4–6 **no** iniciadas. Sin LLM ni APIs reales; la mensajería es MOCK y nunca envía.

**Correcciones P0 abordadas** (interpretación: el pedido nombra explícitamente dos; tomé como tercera el pendiente de IT-05):
1. Recordatorios duplicados al re-ejecutar el job → deduplicación estable + frecuencia + outbox (ADR-015).
2. Acceso amplio de ADVISOR/COMPLIANCE → mínimo privilegio por cartera, asignación y auditoría justificada (ADR-016).
3. IT-05 sin la transición `CONTACT_SUPPRESSED` del journey → completado.

## 1. Validación (comandos ejecutados sobre el código final)

| Comando | Resultado real |
|---|---|
| `pnpm lint` | exit 0, 0 errores y 0 warnings |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (unitarios, sin BD) | exit 0 — **9 archivos, 146 tests** (86 previos sin regresión + 60 nuevos) |
| `pnpm test:integration` (PostgreSQL `vehicle_care_test`) | exit 0 — **6 archivos, 86 tests** (52 previos + 34 nuevos) |
| `pnpm test:coverage` | `src/domain`: 99,79 % stmts · **97,36 % ramas** · 100 % funciones · 100 % líneas. `journey/`: 100 % líneas, 92,9 % ramas. `contact/`, `replay`, `tools`, `redundancy`: 100 % (el reporte omite los archivos totalmente cubiertos) |
| `pnpm build` | exit 0 |
| `pnpm db:verify-migrations` | base desechable → 8 migraciones desde cero → «No difference detected» → seed → base eliminada |

Estabilidad: la suite de concurrencia del journey se ejecutó 5 veces seguidas sin fallos.

## 2. Archivos

**Dominio (puro):**
- `src/domain/journey/{states,events,context,machine,tools,replay,redundancy,index}.ts`
- `src/domain/contact/contact-policy.ts`
- `src/domain/policies/access-policy.ts` (reescrito: cartera, asignación, auditoría y `decideCaseResolution`)
- `src/domain/shared/local-date.ts` (+`addDaysToLocalDate`)

**Aplicación:**
- `src/application/transaction.ts` (transacción con reintento y backoff)
- `src/application/journey/journey-store.ts` (idempotencia, bloqueo optimista, efectos, verificación)
- `src/application/dispatch-maintenance-reminder.ts` (reescrito: deduplicación, frecuencia, outbox)
- `src/application/run-evaluation-job.ts` (integra la FSM)
- `src/application/report-safety-signal.ts`, `src/application/resolve-human-case.ts`
- `vehicle-access.ts` y `evaluate-vehicle.ts` (ciclo y servicio de referencia)

**Integraciones:** `src/integrations/ports/notifications.ts`, `src/integrations/mock/mock-notifications.ts`.

**Infra:** `src/infra/seed/demo-seed.ts` (asignaciones de cartera idempotentes).

**Tests:**
- Unitarios: `src/domain/journey/__tests__/{machine,replay}.test.ts`, `src/domain/contact/__tests__/contact-policy.test.ts`, `access-policy.test.ts` (reescrito).
- Integración: `tests/integration/{journey-store,reminders,safety-handoff}.integration.test.ts`. Ajustados `it-01-06` e `invariants`: ahora aportan las claves que exigen los nuevos invariantes y prueban la deduplicación.

**Docs:** ADR-015, ADR-016; ARCHITECTURE (§6, ADRs, D-07, D-31…D-34), AGENT_DESIGN §4.1, DATA_MODEL (§3 y §4), IMPLEMENTATION_PLAN, README.

## 3. Migraciones

| Migración | Contenido |
|---|---|
| `20261028210000_phase3_journey_contact_scope` | `JourneyInstance.context`; `JourneyEvent.idempotencyKey` (única); `OutboundMessage.dedupKey` (única), `cycleKey` y FK `evaluationId`; frecuencia en `CommunicationPolicy`; `MaintenanceEvaluation.baselineServiceRecordId`/`cycleKey`; tabla `PortfolioAssignment`. CHECKs: tipo de evento ∈ catálogo de negocio, clave de idempotencia y de deduplicación obligatorias (**`NOT VALID`**, no bloquean tablas con datos), `seq ≥ 1`, límites de frecuencia, rango de asignación y una asignación activa por par |
| `20261028210100_phase3_case_journey_link` | `HumanCase.journeyId` (FK + índice) para resolver el caso sobre su journey |

Las migraciones ya aplicadas no se editaron. El SQL de Prisma se generó con `migrate diff` (el modo interactivo de `migrate dev` no está disponible para el agente) y se verificó sin drift.

## 4. Decisiones (ADR-015 / ADR-016)

- **FSM declarativa pura:** 22 eventos de negocio, 19 estados, roles por evento, guardias y efectos. Errores tipados `TERMINAL_STATE | ACTOR_NOT_PERMITTED | INVALID_TRANSITION | GUARD_REJECTED`; nunca hay no-op silencioso.
- **Eventos y conversación separados:** el payload solo lleva identificadores. La BD rechaza tipos que no son eventos de negocio y un test mantiene el catálogo sincronizado con el CHECK.
- **Persistencia:** idempotencia → FSM → `UPDATE … WHERE version` → `JourneyEvent(seq = versión)` → efectos, todo en una transacción. `VERSION_CONFLICT` no se reintenta si hay `expectedVersion`; sin ella se reintenta con backoff.
- **Recordatorios:** clave estable (ciclo + política + ventana + tipo), sin `inputHash`. Separación mínima 14 días y tope 2 por ciclo, configurables. Sin consentimiento: `SUPPRESSED` una vez por ventana. El puerto MOCK se invoca solo después del commit y solo con mensajes nuevos.
- **Seguridad:** `SAFETY_SIGNAL` desde cualquier estado activo. Crea un caso URGENT asignado al asesor de cartera e invalida la intención pendiente, de forma atómica. Solo un humano asignado sale del estado, y la salida queda en `JourneyEvent` y `AuditLog`.
- **Privilegios:** el asesor ve solo su cartera o sus casos asignados. Compliance solo audita con justificación o lee un caso asignado. La resolución de casos exige asignación.

## 5. Tests que cubren los requisitos

| Requisito | Tests |
|---|---|
| FSM-01…FSM-12 | `machine.test.ts` (12 casos del plan) |
| a) concurrencia | conflicto de versión entre usuarios; 8 eventos concurrentes con secuencia 1..9 sin huecos; reintentos paralelos con la misma clave → 1 evento; 3 jobs concurrentes → 1 mensaje y 1 notificación |
| b) deduplicación | 3 ejecuciones del job → 2 mensajes y 1 notificación; clave estable sin `inputHash`; ventanas de 7, 14 y 28 días con `FREQUENCY_CAP`; tope configurable |
| c) sin consentimiento | `SUPPRESSED` una vez por ventana, sin `consentEventId` y sin llamar al puerto; re-otorgar → envío y `NEED_DETECTED`; unitarios de `planReminder` |
| d) rol y asignación | `access-policy.test.ts` (cartera vigente vs. anterior vs. vencida, caso asignado, auditoría con justificación, taller, sistema); integración: el asesor ve C1/C2 y no C3, compliance sin perfiles, el acceso por caso se retira al resolverlo |
| e) seguridad | desde todo estado activo; invalidación de la intención; bloqueo comercial (FSM, `allowedTools`, confirmación tardía); no se deja caso huérfano en un journey cerrado; resolución solo por un humano asignado |
| f) reintentos idempotentes | `DUPLICATE` / `IDEMPOTENCY_MISMATCH`; señal y resolución reintentadas sin duplicar caso, evento ni AuditLog |
| g) estado vs. eventos | `replayJourney` (unitario: huecos, encadenamiento, transiciones ilegales, versión) y `verifyJourneyConsistency` en integración, incluida la detección de un estado manipulado por SQL |

## 6. Fallos durante la ejecución

1. Cuatro tests de Fase 2 fallaron porque insertaban filas directas sin `dedupKey`/`idempotencyKey`. Eran los nuevos invariantes funcionando: se actualizaron los datos de esos tests y se añadió un test del invariante.
2. Un test nuevo esperaba `deduplicated: true` en la segunda ejecución del job. El diseño correcto devuelve `SKIPPED: MIN_INTERVAL`, porque la separación mínima se evalúa antes de escribir. Se corrigió la expectativa.
3. **Diseño corregido antes de los tests:** invocar el puerto de notificaciones dentro de la transacción habría producido efectos duplicados u huérfanos en reintentos o rollbacks. Se movió la entrega a después del commit.
4. Riesgo de intermitencia en concurrencia (4 intentos con 8 transacciones) → 8 intentos con backoff y jitter. Verificado con 5 ejecuciones.
5. `migrate dev --create-only` rechazó el modo no interactivo → SQL generado con `migrate diff` contra la BD de desarrollo migrada, sin drift.

## 7. Riesgos restantes

- **Outbox sin worker:** si el proceso cae entre el commit y la entrega, el mensaje queda registrado sin entregar. Con un proveedor real (Fase 4) hace falta un worker con reintentos y estado de entrega.
- **`CLOSED` es terminal** y hay un solo journey por vehículo y servicio: tras un cierre manual, el job ya no gestiona ese servicio (D-33).
- **Casos sin cartera** quedan `OPEN` sin asignar. Falta el rol supervisor y la asignación con SLA (D-34, Fase 6).
- **`AUDIT_READ`** solo lo valida la política; el registro de la justificación en `AuditLog` llega con el panel (Fase 6).
- **Sin alcance por agencia o sede** (una sola agencia demo).
- **Las restricciones `NOT VALID`** deben validarse (`VALIDATE CONSTRAINT`) en entornos con datos previos.
- **El texto de `HumanCase.minimalContext.summary`** proviene del usuario o del agente: tratarlo como no confiable al mostrarlo (Fase 5/6).
- **D-31 y D-32** (frecuencia y SLA de seguridad) son provisionales y requieren validación de producto, jurídica y operativa.

## 8. Siguiente paso (requiere revisión)

Fase 4 — puertos y mocks de taller y CRM, cotización, cupos, `prepareBooking`/`confirmBooking` idempotentes conectados a esta FSM.
