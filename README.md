# Vehicle Care — MVP (Colombia)

Primer mantenimiento postventa con un motor de mantenimiento determinista. Producto y diseño en [`prd/`](./prd):
PRD, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AGENT_DESIGN.md`, `IMPLEMENTATION_PLAN.md` y ADRs en `prd/adr/`.

> ⚠️ Todos los vehículos, planes, intervalos y políticas del repositorio son **sintéticos** (`SYNTHETIC-DEMO:`).
> No son datos técnicos de ningún fabricante.

## Estado

Fases 0 (scaffold), 1 (Maintenance Engine), 2 (persistencia, seed, políticas, evaluación sobre PostgreSQL), 3 (máquina de estados del journey, idempotencia, deduplicación de recordatorios, mínimo privilegio, escalamiento de seguridad), 4 (cotización, cupos, intención y confirmación de reservas, órdenes de trabajo; taller y CRM MOCK) y 5 (agente MaintenanceAdvisor, Tool Gateway, API `/api/agent/turn`) 6 (interfaz navegable: portal del propietario, asistente, trazas y bandeja humana) y 7 (endurecimiento de la demo pública, accesibilidad, evaluación agéntica y paquete de entrega) implementadas. Integraciones reales: pendientes. **Paquete de entrega: [`prd/ENTREGA.md`](./prd/ENTREGA.md).** Taller, CRM y mensajería son simulados (MOCK): la mensajería nunca envía.

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
pnpm eval:agent                 # evaluación agéntica (12 casos, base desechable) con ScriptedLlm, sin costo
# Con Claude real (gasta créditos; requiere aprobación y presupuesto):
# EVAL_LLM=anthropic EVAL_BUDGET_USD=2 ANTHROPIC_API_KEY=… pnpm eval:agent

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
- `LLM_PROVIDER=anthropic`: Claude vía SDK oficial; requiere `ANTHROPIC_API_KEY` (solo en `.env`, nunca en el repositorio).
  - `LLM_MODEL`: por defecto `claude-sonnet-5-5`, el modelo recomendado (Fases 8A–8B). `claude-opus-5-5` está disponible para comparar.
  - `LLM_EFFORT`: por defecto `medium`.
  - `LLM_PROMPT_CACHE`: activado por defecto.
- **Evaluación con Claude real (gasta créditos; requiere aprobación):**
  - `EVAL_LLM=anthropic EVAL_BUDGET_USD=<tope> EVAL_MODELS=claude-sonnet-5-5,claude-opus-5-5 pnpm eval:agent` corre los 36 casos y se detiene al alcanzar el tope. `EVAL_SMOKE=1` corre solo 3 casos.
  - Pruebas en vivo: `RUN_LIVE_LLM_EVALS=1 pnpm test:evals`. Sin esa variable se omiten, aunque la key exista.
  - Resultados en `prd/reports/REPORT_FASE_8A.md` y `REPORT_FASE_8B.md`. Las pruebas generales (Vitest, Playwright) se niegan a usar un LLM real sin autorización explícita.
- Para validar la app en local sin costo: `LLM_PROVIDER=scripted pnpm start`.
- **Journey completo con Claude real desde la UI (gasta créditos; requiere aprobación):** `E2E_REAL_LLM=1 pnpm exec playwright test` corre solo los tests `@real` (escenarios A–D en lenguaje natural) y exige que el servidor use de verdad Claude. Resultados en `prd/reports/REPORT_FASE_8C.md`.
- API: `POST /api/agent/turn`, `POST /api/bookings/confirm`, `POST /api/demo/session` (solo `DEMO_MODE=true`). Contratos en `prd/PHASE6_HANDOFF.md`.

## Demo navegable (Fase 6)

1. `pnpm db:up && pnpm db:migrate:deploy && pnpm db:seed`, `DEMO_MODE=true` en `.env`, `pnpm build && pnpm start`.
2. En la portada elige un escenario. Cada uno crea un **propietario y un vehículo sintéticos nuevos**, aislados de otras sesiones; no hay reset ni seed por HTTP.
   - **A. Primer mantenimiento con reserva:** pregunta, cotiza, elige horario y pulsa «Confirmar reserva»; recibes el folio del taller simulado.
   - **B. Historial insuficiente:** usa el servicio «Correa de distribución». El estado queda en «Sin datos suficientes» y se abre un caso.
   - **C. Síntoma de seguridad:** el asistente se detiene y las cotizaciones quedan bloqueadas hasta la decisión humana.
   - **D. Cupo que desaparece:** después de preparar la reserva, pulsa «Simular que otro cliente tomó el cupo» y luego confirma. Verás el conflicto y podrás elegir otro horario.
3. «Ver como → Asesor, escenario X» (o «Entrar como asesor» en la portada) abre la **bandeja de casos** del asesor propio de esa corrida. Desde ahí se resuelven los casos de B y C, y «Trazas» muestra la línea de tiempo con herramientas, fuentes (MOCK/interno), estado y responsable.

Cada visitante solo puede entrar como personas de corridas iniciadas en su navegador (cookie firmada). Las personas fijas del seed solo están disponibles con `DEMO_SEED_PERSONAS=true`, para uso local (ADR-020).

Todo lo simulado lleva un sello punteado. Con `LLM_PROVIDER=scripted` el asistente se rotula **«Asistente simulado (ScriptedLlm)»: no es IA generativa**.

Pantallas: `/` (escenarios), `/vehiculo/[id]` (portal y asistente), `/trazas/[id]`, `/casos`. API y decisiones: ADR-019 y ADR-020.

## Despliegue en Vercel

**No desplegado; no hay URL pública.** El build compila sin secretos ni base, así que es apto para Vercel. La auditoría de configuración y los pasos exactos (Postgres del Marketplace, variables, `migrate deploy` con la URL directa, verificación con `E2E_BASE_URL=<url> pnpm test:e2e` y reversión) están en [`prd/DESPLIEGUE.md`](./prd/DESPLIEGUE.md).

## Entrega

- Paquete e índice: [`prd/ENTREGA.md`](./prd/ENTREGA.md)
- Demo local reproducible y guion de grabación (máx. 5 min): [`prd/GUIA_DEMO.md`](./prd/GUIA_DEMO.md)
- Auditoría frente al PRD, el resumen ejecutivo y el modelo financiero: [`prd/AUDITORIA_CONSISTENCIA.md`](./prd/AUDITORIA_CONSISTENCIA.md)
- Informe de cierre: [`prd/reports/REPORT_CIERRE.md`](./prd/reports/REPORT_CIERRE.md)
- Informe de entrega final (decisiones D1–D6 y notas del resumen): [`prd/reports/REPORT_ENTREGA_FINAL.md`](./prd/reports/REPORT_ENTREGA_FINAL.md)
