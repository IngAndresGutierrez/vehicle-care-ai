# Informe — Fase 7 (validación, endurecimiento de la demo y entrega)

**Fecha:** 2026-10-29 · **Alcance:** sin funcionalidades de negocio nuevas, sin SOAT, seguros ni RUNT, sin agentes ni servicios nuevos. **El Maintenance Engine y sus reglas no cambiaron.** No se agregaron migraciones ni se borraron datos.

## 1. LLM real: no ejecutado

- **Entorno:** no hay `ANTHROPIC_API_KEY` en el entorno ni en `.env`, y no hay autorización de gasto. **No se llamó a la API de Anthropic.** La demo sigue con `ScriptedLlm`, rotulado en la interfaz como «Asistente simulado (ScriptedLlm)» y «Respuesta programada (simulación, no IA generativa)».
- **Revisión estática del adaptador** (`src/agent/llm/anthropic-llm.ts`) contra la referencia del SDK para Claude Opus 5.5:

| Aspecto | Comportamiento del adaptador | Compatibilidad |
|---|---|---|
| `thinking` | No se envía (pensamiento adaptativo) | ✔ |
| `output_config.effort` | Configurable, `medium` por defecto | ✔ |
| `tool_choice` | `auto` | ✔ (la elección forzada devuelve 400 en este modelo) |
| Herramientas | `strict: true` | ✔ |
| Fallback de rechazo | `fallbacks: "default"` con la beta `server-side-fallback-2026-07-01` | ✔ (pareja correcta) |
| Historial | Prefijo estable y sin ediciones (ADR-018) | ✔ |
| `stop_reason: refusal` | Se maneja | ✔ |

- **Listo para ejecutar con presupuesto:**
  - `EVAL_LLM=anthropic EVAL_BUDGET_USD=<monto> pnpm eval:agent` corre los 12 casos de la sección 3 y se detiene al alcanzar el presupuesto. Registra tokens, latencia y costo. La tarifa sale de la referencia del SDK (USD 4/20 por MTok para Opus 5.5) y se puede sobrescribir con `EVAL_PRICE_IN_PER_MTOK`/`EVAL_PRICE_OUT_PER_MTOK`.
  - `pnpm test:evals` tiene 2 pruebas en vivo; sin key quedan **skipped**.
  - **Estimación previa, no medida:** 19 turnos, con 2–3 llamadas al modelo por turno (bucle de herramientas) y 10–20 mil tokens de entrada por llamada. Con la tarifa de referencia, el costo estaría en el orden de **USD 2–8**. Para la primera corrida conviene un presupuesto de USD 5–10; el script se detiene al alcanzarlo.

## 2. Demo pública: endurecimiento (ADR-020)

| Riesgo encontrado | Corrección |
|---|---|
| Todas las corridas compartían el asesor `act-advisor`, así que un visitante podía ver y resolver los casos de otro, con el texto libre incluido | Un asesor sintético por corrida, con cartera de un solo cliente |
| `/api/demo/session` aceptaba cualquier cuenta demo conociendo su id | Solo personas de corridas iniciadas en el mismo navegador (cookie firmada `vc_demo_runs`). Personas del seed solo con `DEMO_SEED_PERSONAS=true`. Si no, 404 indistinto |
| El límite por IP vive en memoria, así que no protege entre instancias | Tope global diario contado en la base (`DEMO_RUNS_PER_DAY`, 429 `DEMO_DAILY_LIMIT`) |
| Cada simulación del escenario D dejaba un horario compartido sin cupo para siempre | Devolución del cupo una vez vencida la intención, registrada en auditoría |
| Sin cabeceras de seguridad; página indexable | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `noindex` y sin `X-Powered-By` (comprobado con `curl` sobre `next start`) |
| Visitantes podrían escribir datos personales | Aviso en el chat; ese texto solo lo ven el visitante y el asesor de su corrida |

Cookies verificadas sobre `next start`: `vc_session` (HttpOnly, SameSite=Lax, Secure, 8 h) y `vc_demo_runs` (HttpOnly, `Path=/api/demo`, Secure).

**Despliegue: no realizado.** No hay CLI ni credenciales de Vercel. Los pasos reproducibles están en el README. **No se publicó ninguna URL.**

## 3. Evaluación agéntica (`pnpm eval:agent`, base desechable)

**Resultados con `ScriptedLlm` (simulación determinista, no IA generativa).** Detalle en `prd/reports/evidence/agent-eval-scripted.json`.

| Métrica | Resultado |
|---|---|
| Casos aprobados | **12/12** (19 turnos) |
| Llamadas a herramientas correctas | 15/18 ejecutadas. Las 3 restantes fueron **rechazos por permiso** del gateway (`TOOL_NOT_ALLOWED_IN_STATE`), el comportamiento esperado |
| Errores de esquema | 0 |
| Tarjetas comerciales mostradas donde están prohibidas (tras seguridad o historial incierto) | 0 |
| Precios no respaldados por catálogo o datos (incluido el intento de inyección «$99.000») | **0** |
| Kilómetros no respaldados (incluida la pregunta directa por el intervalo de la correa) | **0** |
| Reservas confirmadas sin clic humano (incluido «confírmala tú mismo») | **0** |
| Detección de seguridad (frenos, humo, dirección, testigo de aceite) | 4/4 verdaderos positivos, 0 falsos negativos, **0 falsos positivos** en 8 casos sin riesgo |
| Escalamiento humano esperado | 2/2 |
| Latencia por turno (sin LLM) | p50 15 ms, p95 32 ms |
| Tokens y costo | 0 (no hay LLM) |

**Cómo leer estos resultados.**
- Con ScriptedLlm se validan los **controles**: gateway, permisos por estado, léxico de seguridad, guardia de salida, tarjetas construidas desde las herramientas y confirmación fuera del agente. **No se mide la calidad conversacional de un modelo**; esa métrica solo existe al ejecutar con Anthropic.
- Hallazgo menor: si el primer mensaje pregunta el precio («¿Cuánto me sale?»), ScriptedLlm intenta cotizar antes de evaluar y el gateway lo rechaza, así que el usuario no recibe cotización en ese turno. Es correcto en seguridad, pero mejorable en experiencia. La demo guía el orden con sugerencias.

**Resultados con Anthropic: no disponibles** (sin ejecución).

## 4. QA final de producto

| Área | Resultado |
|---|---|
| Recorridos A–D | E2E en escritorio y móvil, 25/25 tests (`prd/reports/evidence/e2e-fase7.txt`). Capturas regeneradas en `prd/reports/screenshots/` |
| Accesibilidad (axe-core, WCAG 2.1 A/AA) | Portada, portal, asistente en seguridad, trazas y bandeja, en escritorio y móvil: **0 violaciones**. Antes de corregir había 2 de contraste: texto atenuado en la cabecera (4,26:1) y la insignia verde (4,36:1); se oscurecieron |
| Estados | Carga (spinners con `role=status`), vacío (bandeja sin casos, historial vacío), error con reintento (500 simulado), sin sesión, acceso denegado y reserva vencida, en conflicto o duplicada |
| Sesiones, autorización y privacidad | 401 sin sesión; 403 en acceso cruzado; aislamiento entre visitantes (nuevo E2E); sin token de confirmación en las páginas ni en las trazas; placa enmascarada |

## 5. Validación final (comandos ejecutados sobre el código final)

| Comando | Resultado real |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | exit 0, 180 tests |
| `pnpm test:integration` | exit 0, **169 tests** (167 previos + 2 nuevos; además se ampliaron casos existentes) |
| `pnpm test:journeys` | exit 0, 13 tests |
| `pnpm test:coverage` (dominio) | 99,8 % stmts · 97,2 % ramas · 100 % funciones · 100 % líneas |
| `pnpm db:verify-migrations` | «No difference detected», seed aplicable |
| `pnpm build` | exit 0 |
| `pnpm test:e2e` | exit 0, **25 tests**: 23 funcionales + 2 de accesibilidad |
| `pnpm test:evals` | 2 **skipped** (sin API key) |
| `pnpm eval:agent` | exit 0, 12/12 casos |

**Fallos encontrados y corregidos en esta fase:**
1. El aislamiento entre visitantes en la bandeja y en el cambio de persona.
2. El deterioro del calendario por el escenario D.
3. Dos fallas de contraste.
4. La falta de cabeceras de seguridad.
5. La prueba del caso «confírmala tú», que era débil: no llegaba a preparar la reserva y se reforzó.

## 6. Limitaciones

- **LLM real sin probar.** Ni la calidad conversacional ni el costo real por conversación están medidos.
- **Sin despliegue público ni URL.**
- **Limitador por IP en memoria.** El tope diario sí es global.
- **Calendario simulado compartido.** Pueden ocurrir conflictos reales entre visitantes, que se recuperan como en el escenario D.
- **Datos que solo crecen** (tablas *append-only*), acotados por los límites.
- **Sin CSP estricta** ni modo oscuro.
- **Sin pantallas** de taller ni de consentimiento; esas partes están cubiertas por la API y las pruebas.
- **Inconsistencias con el modelo financiero y el resumen ejecutivo.** Están en `prd/ENTREGA.md` §7 y **requieren revisión humana**; no se modificaron esos documentos.
