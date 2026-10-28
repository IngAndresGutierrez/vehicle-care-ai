# Informe — Fase 2 (persistencia, seed, políticas y evaluación sobre PostgreSQL)

**Fecha:** 2026-10-28 · **Alcance:** solo Fase 2 de `IMPLEMENTATION_PLAN.md`. Fases 3–6 **no** iniciadas. Sin LLM, WhatsApp, CRM ni sistemas reales.

## 1. Resultados de validación (comandos ejecutados)

| Comando | Resultado real |
|---|---|
| `pnpm lint` | exit 0, sin errores ni warnings |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (unitarios, sin BD) | exit 0 — **6 archivos, 86 tests** (los 68 previos + 18 de políticas) |
| `pnpm test:coverage` | `src/domain`: 98,42 % stmts · **98,37 % ramas** · 99,2 % líneas; `policies/`: 100 % líneas, 97,7 % ramas |
| `pnpm test:integration` (PostgreSQL `vehicle_care_test`) | exit 0 — **3 archivos, 51 tests** |
| `pnpm build` | exit 0 |
| `pnpm db:verify-migrations` | base desechable `vehicle_care_migcheck_<ts>` → 6 migraciones aplicadas desde cero → `migrate diff`: «No difference detected» → seed aplicado → base eliminada |
| `pnpm db:seed` ×2 sobre `vehicle_care` | primera ejecución siembra; segunda no modifica nada (idempotente) |

Unitarios e integración están separados por proyecto de Vitest: `unit` (`src/**/__tests__`, sin I/O) e `integration` (`tests/integration`, PostgreSQL real, secuencial).

## 2. Archivos

**Prisma:** `prisma/schema.prisma` (36 modelos, 23 enums), `prisma/seed.ts`, `prisma.config.ts` (`PRISMA_TARGET=test` → `DATABASE_URL_TEST`; comando de seed).
**Migraciones:**

| Migración | Contenido |
|---|---|
| `00000000000000_baseline` | vacía (Fase 0) |
| `20261028200432_phase2_data_model` | tablas, enums, FKs e índices generados por Prisma |
| `20261028200500_phase2_invariants` | titular único vigente, rótulo sintético, aprobación de planes, intervalos, políticas únicas activas, integridad de evaluaciones/mensajes/cotizaciones/reservas/órdenes/casos/cupos, triggers append-only |
| `20261028200600_phase2_rule_timing_scope` | regla de distribución solo `BELT`/`CHAIN` |
| `20261028200700_phase2_append_only_errcode` | SQLSTATE propio `P0A01` para append-only |
| `20261028200800_phase2_null_safe_checks` | corrige CHECKs que aceptaban NULL (bug detectado por los tests) |

**Dominio (puro):** `src/domain/policies/access-policy.ts`, `consent-policy.ts` y sus tests.
**Aplicación:** `src/application/{errors,vehicle-access,evaluation-context-builder,evaluate-vehicle,dispatch-maintenance-reminder,run-evaluation-job,get-vehicle-profile,get-service-history}.ts`.
**Infra:** `src/infra/prisma.ts` (Prisma 7 + `@prisma/adapter-pg`), `src/infra/seed/demo-seed.ts`.
**Tests/scripts:** `tests/integration/{global-setup.ts, helpers/*, it-01-06, evaluate-vehicle, invariants}.integration.test.ts`, `scripts/verify-migrations.ts`.
**Docs:** `prd/adr/ADR-014-persistencia-fase-2.md`; `DATA_MODEL.md` (§3 = esquema real, §4 invariantes, §5 seed); `IMPLEMENTATION_PLAN.md`; `ARCHITECTURE.md` (tabla ADR); `README.md`.
**Dependencias:** `@prisma/client` y `@prisma/adapter-pg` 7.10.1, `pg`; dev: `tsx`, `@types/pg`.

## 3. Seed sintético

V1–V4, C1–C3, T1–T2, 8 actores demo, plan demo `VALIDATED`, políticas `demo-comm-v1`/`demo-dq-v1`, consentimientos con evidencia, 2 OTs, 3 servicios, 6 lecturas y 7 cupos mock. Plan, reglas, políticas y registros de V1/V2 **se toman de los fixtures del motor**; no hay intervalos nuevos. Todo es `SYNTHETIC` con `SYNTHETIC-DEMO:prisma/seed#<id>`; la marca es ficticia («DemoMotors») y los contactos usan el dominio reservado `.invalid`.

Resultados del job a la fecha demo (IT-05): V1 aceite `UPCOMING` (recordatorio `SIMULATED_SENT` con la evidencia `cons-cust-demo-c1-rem-wa-ev1`), V2 aceite `DUE` (recordatorio `SUPPRESSED`, `CONSENT_REQUIRED`, sin `consentEventId`), V2 correa `UNKNOWN[INSUFFICIENT_HISTORY]`, V3 aceite `NOT_DUE`, correas de V1/V3 `NOT_APPLICABLE`, V4 `UNKNOWN[ENGINE_UNIDENTIFIED]`.

## 4. Tests de integración (51)

| Grupo | Cobertura |
|---|---|
| IT-01 | conteos, una política activa de cada tipo, todo `SYNTHETIC` rotulado, seed idempotente |
| IT-02 | perfil de V1 sin placa, VIN, email, teléfono, nombre ni ID del cliente |
| IT-03 | `WORKSHOP_VERIFIED` vs `OWNER_DECLARED` + `dataOrigin`/`syntheticSourceRef` |
| IT-04 | otro cliente, titular anterior y vehículo inexistente → `UNAUTHORIZED`; taller solo con servicio propio |
| IT-05 | `SUPPRESSED` sin `consentEventId`; `SIMULATED_SENT` con evidencia; solo estados accionables generan mensaje |
| IT-06 | `UPDATE`/`DELETE` sobre `JourneyEvent` rechazados por trigger |
| evaluate-vehicle | V1 desde BD = motor sobre fixture (ejemplo del PRD); fila persistida con hash, versión, traza, fuente, plan y origen; reproducibilidad; V2 (ADR-009), V3, V4; autorización; builder (rechazadas, correcciones, fechas, borrador vs validada, `AMBIGUOUS_PLAN`, `POLICY_MISSING`) |
| Invariantes | ADR-010 (mensajes), ADR-011 (rótulos, `WORKSHOP_VERIFIED` ⇒ OT), ADR-012 (integridad técnico/comunicación, políticas únicas), ADR-013/014 (aprobación de planes, reglas, reservas, cotizaciones, casos, órdenes, cupos), append-only en 8 tablas |

## 5. Fallos encontrados y corregidos

1. **Bug en mis CHECKs (detectado por los tests):** `dataOrigin='SYNTHETIC'` con `syntheticSourceRef` NULL **se aceptaba**, porque un CHECK que evalúa a NULL se considera cumplido. Al revisar encontré el mismo defecto en `MaintenanceEvaluation_status_integrity` con `communicationStatus` NULL. Corregido en una migración nueva, con test de regresión.
2. **Código de error engañoso:** con SQLSTATE `23001`, Prisma informaba la violación append-only como «Foreign key constraint violated». Migración con SQLSTATE `P0A01`.
3. **`prisma migrate reset` bloqueado** por Prisma para agentes de IA sin consentimiento del usuario. No lo forcé: uso `migrate deploy` (no destructivo) y una base desechable para comprobar desde cero.
4. Las migraciones ya aplicadas no se editaron; cada corrección es una migración nueva.

## 6. Supuestos y decisiones pendientes de validación

- D-01…D-04, D-29, D-30 (sin cambios; ver ADR-013).
- **Nuevos (ADR-014):** prioridad de canales de recordatorio `WHATSAPP → EMAIL → SMS`; el `SUPPRESSED` registra el canal preferido. Acceso amplio de lectura para `ADVISOR`/`COMPLIANCE` (matriz de AGENT_DESIGN §4.1; revisar el mínimo privilegio). El taller accede solo con servicio u OT propios.
- `SYSTEM_JOB` evalúa pero no lee perfiles.
- `ENGINE_OIL_FILTER` se evalúa también en vehículos sin plan (`PLAN_MISSING` trazable).

## 7. Riesgos

- `TRUNCATE` no dispara los triggers append-only: en producción el rol de la app no debe tener ese privilegio.
- Re-ejecutar el job duplica evaluaciones y mensajes, porque no hay idempotencia por evaluación ni por ventana de contacto. Debe resolverse antes del piloto (Fase 3/4: deduplicación o frecuencia máxima de contacto).
- `ADVISOR` y `COMPLIANCE` ven cualquier vehículo; falta segmentar por agencia o cartera.
- `vehicleIdHash` (pseudonimización en logs) llega con el gateway en la Fase 5.
- IT-05 cubre el mensaje suprimido; la transición `CONTACT_SUPPRESSED` del journey depende de la FSM (Fase 3).
- El seed importa los fixtures del motor desde `__fixtures__`; si el catálogo sintético crece, conviene moverlo a un módulo propio.

## 8. Siguiente paso (requiere revisión)

Fase 3 — máquina de estados del journey, eventos, bloqueo optimista y la parte pendiente de IT-05.
