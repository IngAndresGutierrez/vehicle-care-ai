# Vehicle Care — MVP (Colombia)

Primer mantenimiento postventa con un motor de mantenimiento determinista. Producto y diseño en [`prd/`](./prd):
PRD, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AGENT_DESIGN.md`, `IMPLEMENTATION_PLAN.md` y ADRs en `prd/adr/`.

> ⚠️ Todos los vehículos, planes, intervalos y políticas del repositorio son **sintéticos** (`SYNTHETIC-DEMO:`).
> No son datos técnicos de ningún fabricante.

## Estado

Fases 0 (scaffold), 1 (Maintenance Engine), 2 (persistencia, seed, políticas, evaluación sobre PostgreSQL) y 3 (máquina de estados del journey, idempotencia, deduplicación de recordatorios, mínimo privilegio, escalamiento de seguridad) implementadas. Agente, reservas, UI e integraciones reales: pendientes. La mensajería es un mock que nunca envía.

## Requisitos

Node ≥ 24, pnpm 12, Docker.

## Comandos

```bash
pnpm install
cp .env.example .env
pnpm db:up                      # PostgreSQL 17 en localhost:54329 (BD vehicle_care y vehicle_care_test)
pnpm db:migrate:deploy          # aplica migraciones a vehicle_care
pnpm db:seed                    # seed sintético (idempotente: no modifica una base ya sembrada)
pnpm db:test:migrate            # aplica migraciones a vehicle_care_test
pnpm db:verify-migrations       # base desechable: migraciones desde cero + drift + seed

pnpm lint                       # ESLint (incluye la frontera del dominio)
pnpm typecheck                  # next typegen + tsc --noEmit
pnpm test                       # Vitest, proyecto unit (sin base de datos)
pnpm test:coverage
pnpm test:integration           # Vitest, proyecto integration (PostgreSQL vehicle_care_test)
pnpm validate                   # lint + typecheck + unit + integración
```

## Estructura

```
src/domain/maintenance-engine/  motor puro: evaluate(), tipos, motivos, fixtures sintéticos y tests
src/domain/policies/            acceso por titularidad vigente y consentimiento por finalidad/canal (puras)
src/domain/shared/              fechas de calendario America/Bogota, Result
src/application/                casos de uso: builder de contexto, evaluate-vehicle, job, recordatorios, lecturas
src/infra/                      Prisma, reloj, ids, logger, seed sintético
prisma/                         esquema, migraciones (con invariantes SQL) y seed
tests/integration/              tests contra PostgreSQL
```
