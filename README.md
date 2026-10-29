# Vehicle Care — MVP (Colombia)

Primer mantenimiento postventa con un motor de mantenimiento determinista. Producto y diseño en [`prd/`](./prd):
PRD, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AGENT_DESIGN.md`, `IMPLEMENTATION_PLAN.md` y ADRs en `prd/adr/`.

> ⚠️ Todos los vehículos, planes, intervalos y políticas del repositorio son **sintéticos** (`SYNTHETIC-DEMO:`).
> No son datos técnicos de ningún fabricante.

## Estado

Fases 0 (scaffold), 1 (Maintenance Engine), 2 (persistencia, seed, políticas, evaluación sobre PostgreSQL), 3 (máquina de estados del journey, idempotencia, deduplicación de recordatorios, mínimo privilegio, escalamiento de seguridad), 4 (cotización, cupos, intención y confirmación de reservas, órdenes de trabajo; taller y CRM MOCK) y 5 (agente MaintenanceAdvisor, Tool Gateway, API `/api/agent/turn`) y 6 (interfaz navegable: portal del propietario, asistente, trazas y bandeja humana) implementadas. Integraciones reales: pendientes. Taller, CRM y mensajería son simulados (MOCK): la mensajería nunca envía.

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
pnpm demo:booking-flow          # base desechable: flujo cotización → reserva con evidencia en prd/reports/evidence/
pnpm demo:agent-journeys        # base desechable: 4 recorridos del agente vía API (ScriptedLlm = simulación determinista)
pnpm test:journeys              # E2E del agente (E2E-01…05 + adversariales)

pnpm lint                       # ESLint (incluye la frontera del dominio)
pnpm typecheck                  # next typegen + tsc --noEmit
pnpm test                       # Vitest, proyecto unit (sin base de datos)
pnpm test:coverage
pnpm test:integration           # Vitest, proyecto integration (PostgreSQL vehicle_care_test)
pnpm validate                   # lint + typecheck + unit + integración
pnpm test:evals                 # LLM real de Anthropic: se omite si no hay ANTHROPIC_API_KEY

pnpm build && pnpm start        # app en http://localhost:3000 (requiere DEMO_MODE=true para la demo)
pnpm test:e2e:install           # una vez: Chromium para Playwright
pnpm build && pnpm test:e2e     # Playwright escritorio + móvil contra `next start` y la base vehicle_care sembrada
```

## Estructura

```
src/domain/maintenance-engine/  motor puro: evaluate(), tipos, motivos, fixtures sintéticos y tests
src/domain/policies/            acceso por titularidad vigente y consentimiento por finalidad/canal (puras)
src/domain/shared/              fechas de calendario America/Bogota, Result
src/application/                casos de uso: builder de contexto, evaluate-vehicle, job, recordatorios, lecturas
src/infra/                      Prisma, reloj, ids, logger, seed sintético
prisma/                         esquema, migraciones (con invariantes SQL) y seed
src/agent/                      MaintenanceAdvisor, Tool Gateway, LLM (Scripted/Anthropic), salvaguardas
src/application/views/          modelos de lectura del portal, trazas y bandeja
src/application/demo/           corridas de demo aisladas (solo DEMO_MODE)
src/app/, src/ui/               páginas Next.js y componentes de la interfaz
tests/integration/              tests contra PostgreSQL
tests/e2e/                      Playwright (escenarios A–D, seguridad, errores; escritorio y móvil)
tests/evals/                    pruebas con el LLM real (se omiten sin ANTHROPIC_API_KEY)
```

## Agente (Fase 5)

- `LLM_PROVIDER=scripted` (por defecto): **simulación determinista por reglas, no IA generativa**; no requiere API key.
- `LLM_PROVIDER=anthropic`: Claude vía SDK oficial (`LLM_MODEL`, por defecto `claude-opus-5-5`); requiere `ANTHROPIC_API_KEY`.
- API: `POST /api/agent/turn`, `POST /api/bookings/confirm`, `POST /api/demo/session` (solo `DEMO_MODE=true`). Contratos en `prd/PHASE6_HANDOFF.md`.

## Demo navegable (Fase 6)

1. `pnpm db:up && pnpm db:migrate:deploy && pnpm db:seed`, `DEMO_MODE=true` en `.env`, `pnpm build && pnpm start`.
2. En la portada elige un escenario. Cada uno crea un **propietario y un vehículo sintéticos nuevos**, aislados de otras sesiones; no hay reset ni seed por HTTP.
   - **A. Primer mantenimiento con reserva:** pregunta, cotiza, elige horario y pulsa «Confirmar reserva»; recibes el folio del taller simulado.
   - **B. Historial insuficiente:** usa el servicio «Correa de distribución». El estado queda en «Sin datos suficientes» y se abre un caso.
   - **C. Síntoma de seguridad:** el asistente se detiene y las cotizaciones quedan bloqueadas hasta la decisión humana.
   - **D. Cupo que desaparece:** después de preparar la reserva, pulsa «Simular que otro cliente tomó el cupo» y luego confirma. Verás el conflicto y podrás elegir otro horario.
3. «Ver como → Asesor de postventa (demo)» abre la **bandeja de casos**. Desde ahí se resuelven los casos de B y C, y «Trazas» muestra la línea de tiempo con herramientas, fuentes (MOCK/interno), estado y responsable.

Todo lo simulado lleva un sello punteado. Con `LLM_PROVIDER=scripted` el asistente se rotula **«Asistente simulado (ScriptedLlm)»: no es IA generativa**.

Pantallas: `/` (escenarios), `/vehiculo/[id]` (portal y asistente), `/trazas/[id]`, `/casos`. API y decisiones: ADR-019.

## Despliegue en Vercel (preparado, no ejecutado)

- **Base de datos:** PostgreSQL gestionado desde el Marketplace de Vercel (p. ej. Neon) con `DATABASE_URL`. Las migraciones **no** corren en el build. Ejecuta una vez desde tu máquina o CI: `DATABASE_URL=… pnpm db:migrate:deploy && DATABASE_URL=… pnpm db:seed`.
- **Variables:** `DATABASE_URL`, `SESSION_SECRET` y `LOG_HASH_SECRET` (≥ 32 caracteres, aleatorios), `DEMO_MODE=true` (solo en el entorno de demo), `LLM_PROVIDER=scripted`. Opcionales: `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `LLM_MODEL`.
- **Build:** `pnpm install` (incluye `prisma generate`) y `next build`. Runtime Node.js por defecto. La cookie de sesión lleva `Secure` en producción.
- **Limitaciones:** el limitador de tasa es en memoria y vale por instancia, no global. Para producción conviene un almacén compartido (p. ej. Redis del Marketplace). Las corridas de demo agregan filas que no se borran (tablas append-only); vigila el tamaño de la base de demo.
