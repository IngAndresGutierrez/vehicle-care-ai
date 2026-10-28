# Informe — Fases 0 y 1 (scaffold + Maintenance Engine)

**Fecha:** 2026-10-28 · **Alcance:** reconciliación de documentos, Fase 0 y Fase 1 de `IMPLEMENTATION_PLAN.md`. Fase 2 **no** iniciada (requiere revisión).

## 1. Resultados de validación (comandos ejecutados)

| Comando | Resultado |
|---|---|
| `pnpm lint` | exit 0, sin errores ni warnings |
| `pnpm typecheck` (`next typegen && tsc --noEmit`) | exit 0 |
| `pnpm test` (Vitest, proyecto `unit`) | exit 0 — **4 archivos, 68 tests en verde** |
| `pnpm test:coverage` | `src/domain`: 98,17 % stmts · **98,51 % ramas** · 99,09 % líneas (`evaluate.ts` 98,88 % ramas) |
| `pnpm build` | exit 0 (página placeholder estática) |
| `docker compose up -d --wait postgres` | contenedor sano; existen las BD `vehicle_care` y `vehicle_care_test` |
| `prisma migrate deploy` / `migrate status` | migración `00000000000000_baseline` aplicada; «Database schema is up to date» |
| Sonda de frontera (archivo temporal en `src/domain` importando `@prisma/client`, `next/headers`, `@/infra/clock`) | ESLint: 3 errores `no-restricted-imports`; el test de frontera también falló, como se esperaba. Sonda eliminada |

## 2. Archivos creados o modificados

**Tooling (raíz):** `package.json` (scripts `lint`, `typecheck`, `test`, `test:coverage`, `validate`, `db:*`), `pnpm-workspace.yaml` (builds de Prisma permitidos), `eslint.config.mjs` (frontera del dominio), `vitest.config.mts` (proyectos `unit`, `integration`, `evals`; `TZ=UTC`), `tsconfig.json` (scaffold), `docker-compose.yml`, `docker/postgres/init/01-create-test-db.sql`, `prisma.config.ts`, `prisma/schema.prisma` (sin modelos), `prisma/migrations/*`, `.env.example`, `.gitignore`, `README.md`, `src/app/{page,layout}.tsx` (placeholder).

**Infra / shared:** `src/infra/{clock,ids,logger}.ts`, `src/domain/shared/{result,local-date}.ts`.

**Maintenance Engine:** `src/domain/maintenance-engine/{types,reasons,evaluate,canonical-hash,index}.ts`, `__fixtures__/synthetic-demo.ts`, `__tests__/{evaluate,properties,boundaries}.test.ts`, `src/domain/shared/__tests__/local-date.test.ts`.

**Documentación:** `prd/ARCHITECTURE.md` (§5 reescrito, AD-6, §4.1, §4.4, §7, tabla ADR, D-01…D-05, D-09, D-14, D-15, nuevas D-29 y D-30, A-10), `prd/DATA_MODEL.md` (`DataOrigin`, `DataQualityPolicy`, `TechnicalDueStatus`, `OutboundMessage`, invariantes, seed V2), `prd/AGENT_DESIGN.md` (contratos `getServiceHistory`, `getMaintenancePlan`, `evaluateMaintenance`, consentimiento, EV-05b, EV-16), `prd/IMPLEMENTATION_PLAN.md` (convenciones, ME-05/13/23, ME-P4, IT-03/05, estado de fases), `prd/adr/ADR-009…ADR-013`.

## 3. Reconciliación de documentos (Paso 1)

| Pedido | Resolución | ADR |
|---|---|---|
| Inconsistencia V2 | Regla demo **validada** de correa (valores ficticios) + sin constancia de cambio ⇒ `UNKNOWN[INSUFFICIENT_HISTORY]` (test ME-23) | 009 |
| `consentEventId` nulo en suprimidos | Nullable + `CHECK` (`SIMULATED_SENT` ⇒ no nulo; `SUPPRESSED` ⇒ `suppressionReason`) | 010 |
| Unificar `MAINTENANCE_REMINDERS` | Corregido `MAINTENANCE_REMINDER` en ARCHITECTURE; el enum es la única fuente | 010 |
| Técnico vs. comunicación | `technical` y `communication` separados en el resultado; `DataQualityPolicy` aparte; invariante ME-P4 | 012 |
| Datos simulados inequívocos | `provenance` ⟂ `dataOrigin`; prefijo `SYNTHETIC-DEMO:` exigido por el motor (y por `CHECK` en Fase 2); `syntheticSources[]` en cada evaluación; marca ficticia «DemoMotors» | 011 |

## 4. Decisiones implementadas

- **Motor puro** `evaluate(input, policies, now)`: sin LLM, Prisma ni Next.js. Lo comprueban ESLint y un test de frontera. Solo usa `node:crypto` para el `inputHash`.
- **Orden de gates:** validación → plan → motor → regla (incluida la condición de uso) → aplicabilidad correa/cadena → consistencia → línea base → dimensiones → técnico → comunicación.
- **Nunca inventa cifras:** cuando el estado es `UNKNOWN`, `dueBy`, `remaining` y `communication` son `null` (propiedad ME-P3).
- **Odómetro obsoleto como cota inferior:** si ya alcanza el límite es concluyente (ME-25); si no, `UNKNOWN[ODOMETER_STALE]` con `CONFIRM_ODOMETER` (ME-24). Sin lectura: `ODOMETER_MISSING`.
- **America/Bogota:** la fecha de negocio se deriva con `Intl`; la aritmética usa días epoch (independiente del TZ del proceso; ME-19/19b); meses con *clamp* a fin de mes y años bisiestos (ME-17/18).
- **Entrada estricta:** instantes ISO **con zona**, km enteros ≥ 0, rótulo sintético coherente; si algo falla, `UNKNOWN[INVALID_INPUT]` con detalle en `decisionTrace`. El motor no lanza por datos de negocio.
- **Reproducibilidad:** `inputHash` = sha256 de JSON canónico (input + políticas + `now` + versión del motor); `engineVersion=1.0.0`.

## 5. Cobertura de los tests pedidos

| Pedido | Tests |
|---|---|
| ME-01…ME-08, ME-26 (km/tiempo) | ME-01…08, ME-26, `BOTH` |
| Fechas America/Bogota | ME-17, ME-18, ME-19, ME-19b, suite `local-date` |
| Datos insuficientes | ME-09…ME-14 (+10b, 13b–d, 14b), `RULE_WITHOUT_INTERVAL` |
| Contradicciones | ME-15, ME-16, ME-20, servicio con fecha futura |
| Odómetro obsoleto/ausente | ME-24, ME-25, borde de 30 días, `ODOMETER_MISSING` (con y sin vencimiento por tiempo) |
| Correa / cadena | ME-21, ME-22, ME-23, regla de correa con historial |
| Incertidumbre y propiedades | ME-P1…P4, 8 casos de `INVALID_INPUT`, rótulo sintético, no mutación, hash |

## 6. Fallos encontrados durante la ejecución (y su corrección)

1. **`tsc`:** `LayoutProps` no definido → `typecheck` ejecuta antes `next typegen`. Además, un estrechamiento de tipos en `evaluate.ts` (corregido con una variable `technicalStatus` literal) y `passWithNoTests` mal ubicado en `vitest.config` (movido a la raíz).
2. **Tests (2 fallos en la primera corrida, ambos en los datos del test, no en el motor):** un caso esperaba `DUE`, pero sus datos excedían la gracia de 30 días (el motor devolvía `OVERDUE`, que es correcto); en ME-17 la lectura por defecto quedaba en el futuro respecto a `now` (`CONTRADICTORY_RECORDS`, también correcto). Se corrigieron los fixtures.
3. **Cobertura de ramas 94,5 % < 95 %:** faltaban tests de validación de entrada; se agregó un test de tabla (8 casos) → 98,5 %.
4. **Prisma `migrate dev`** no crea migraciones sin cambios de esquema → migración base explícita aplicada con `migrate deploy`.
5. **Vite** advertía de ESM en una config cargada como CJS → `vitest.config.ts` renombrado a `.mts`; la advertencia desaparece.
6. **Entorno:** los documentos se movieron de la raíz a `prd/` durante la sesión (junto con el `AGENTS.md` generado por Next). Se editaron en su nueva ubicación; los enlaces relativos entre ellos siguen funcionando.

## 7. Riesgos y pendientes

- **Validación externa pendiente:** D-01…D-04, D-29 (producto + responsable técnico) y D-30 (intervalos reales). Todo valor actual es `SYNTHETIC-DEMO`.
- El `README.md` y `ARCHITECTURE §3.1` asumen los documentos en `prd/`; si vuelven a la raíz hay que ajustar los enlaces del README.
- `next dev` puede volver a crear `AGENTS.md` en la raíz (lo indica el propio archivo).
- Sin repositorio git inicializado: no hay commits.

## 8. Siguientes pasos (requieren revisión antes de empezar)

1. Revisar y aprobar ADR-009…013 y las decisiones provisionales.
2. **Fase 2:** modelos Prisma de `DATA_MODEL.md §3`, migración SQL de invariantes (incluidos los nuevos `CHECK` de ADR-010/011), seed V1–V4 reutilizando los fixtures sintéticos, `EvaluationContextBuilder` (BD → `EvaluationInput`) y tests IT-01…IT-06 contra `vehicle_care_test`.
3. **Fase 3:** máquina de estados del journey (FSM-01…12).
