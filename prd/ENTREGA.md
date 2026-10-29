# Vehicle Care — Paquete de entrega final

**Fecha:** 2026-10-29 · **Alcance:** primer mantenimiento postventa (Colombia). Todos los datos son **sintéticos**; taller, CRM y mensajería son **simulados (MOCK)**.

> **Estado del LLM:** la demo y todas las pruebas usan `ScriptedLlm`, una **simulación determinista por reglas que no es IA generativa** y así aparece rotulada en la interfaz. El adaptador de Anthropic está implementado y revisado contra la referencia del SDK, pero **no se ha ejecutado contra la API**: no hay `ANTHROPIC_API_KEY` ni autorización de gasto. No se declara probado un LLM real.

## 0. Contenido del paquete (entregables de la prueba)

| Entregable solicitado | Archivo(s) | Estado |
|---|---|---|
| **01 Prototipo funcional** | Repositorio completo (`src/`, `prisma/`, `tests/`); README; guía de presentación y guion de grabación en `prd/GUIA_DEMO.md` | Demostración local reproducible. **Sin URL pública** (ver §8) |
| **02 Resumen ejecutivo** (PDF ≤ 2 páginas) | `prd/Vehicle_Care_Resumen_Ejecutivo_Comite.pdf` (notas rev. 29 oct 2026) | 2 páginas A4. Solo cambiaron **dos bloques de notas de la p. 2** (decisiones D1–D6); proyecciones idénticas (0 píxeles distintos fuera de las notas). Original en `prd/historico/`; script en `prd/tools/actualizar_notas_resumen.py` |
| **03 Modelo financiero reproducible** | `prd/vehicle_care_finanzas.xlsx` | **Intacto** (sin cambios frente al repositorio). Recálculo independiente: 768 fórmulas, **0 diferencias** (`prd/AUDITORIA_CONSISTENCIA.md` §1) |
| **Declaración de uso de IA** | §5 de este documento (corta) y `prd/Declaracion_Uso_IA_Vehicle_Care.md` (extendida) | Consistentes con el PDF |
| Documentación de soporte | `prd/PRD_Vehicle_Care_v1.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AGENT_DESIGN.md`, `prd/adr/` (ADR-009…020), `prd/reports/` | — |
| Auditoría y despliegue | `prd/AUDITORIA_CONSISTENCIA.md`, `prd/DESPLIEGUE.md` | — |

## 1. Cómo ejecutarlo

**URL pública: no publicada.** No hay CLI ni credenciales de Vercel en el entorno. Los pasos exactos de despliegue están en `prd/DESPLIEGUE.md`.

Ejecución local reproducible (requiere Node ≥ 24, pnpm y Docker):

```bash
pnpm install && cp .env.example .env      # DEMO_MODE=true, LLM_PROVIDER=scripted
pnpm db:up && pnpm db:migrate:deploy && pnpm db:seed
pnpm build && pnpm start                  # http://localhost:3000
```

Guion de 4 a 5 minutos: `prd/GUIA_DEMO.md`. Detalle de cada escenario: README, sección «Demo navegable».

## 2. Evidencia de los cuatro escenarios

Prueba automatizada con Playwright sobre `next start`, en escritorio (1440×900) y móvil (Pixel 7). Registros: `prd/reports/evidence/e2e-fase7.txt` y, en el cierre, `prd/reports/evidence/e2e-cierre.txt` (25/25 en ambos).

| Escenario | Resultado verificado | Capturas (`prd/reports/screenshots/`) |
|---|---|---|
| **A.** Mantenimiento → cotización → disponibilidad → reserva → folio | Evaluación UPCOMING, 333.200 COP (catálogo simulado), horarios, tarjeta de reserva, **clic del propietario**, folio `FOLIO-T1-DEMO-…`, estado «Reservado» y trazas consistentes | `*-A1-portal`, `*-A2-intencion`, `*-A3-confirmada`, `*-A4-trazas` |
| **B.** Historial insuficiente → escalamiento humano | Estado UNKNOWN sin intervalo inventado → caso «Historial insuficiente» → el asesor de la corrida lo cierra con una nota | `*-B1-caso-humano`, `*-B2-bandeja` |
| **C.** Riesgo de seguridad → interrupción del agente | Aviso de seguridad, asistente detenido, 0 cotizaciones → caso urgente → el asesor habilita el agendamiento → trazas con «Caso resuelto por una persona» | `*-C1-seguridad`, `*-C2-bandeja-urgente`, `*-C3-trazas` |
| **D.** Conflicto de cupo → recuperación | Cupo tomado (simulado) → `SLOT_CONFLICT` sin reserva → otro horario → folio | `*-D1-conflicto`, `*-D2-nueva-confirmacion` |

También hay evidencia por API (Fase 5) en `prd/reports/evidence/agent-journeys.json` y una evaluación agéntica en `prd/reports/evidence/agent-eval-scripted.json`.

## 3. Informes

- `prd/reports/REPORT_FASE_7.md`: validación final, QA, evaluación agéntica, correcciones y limitaciones.
- `prd/reports/REPORT_FASE_0_1.md` a `REPORT_FASE_6.md`: informes por fase.
- `prd/adr/ADR-009` a `ADR-020`: decisiones de arquitectura.

## 4. Inventario: componentes reales y simulados

| Componente | Estado | Detalle |
|---|---|---|
| Maintenance Engine | **Real (código)** con **reglas sintéticas** | Determinista y sin dependencias de LLM, Prisma ni Next. Plan `demo-2026.10-r1` con fuente `SYNTHETIC-DEMO:`; no es un dato de fabricante |
| Persistencia (PostgreSQL 17, Prisma) | Real | Migraciones con invariantes SQL, auditoría *append-only*, bloqueo optimista |
| Journey (máquina de estados), políticas de acceso y consentimiento | Real | Reglas en código, pruebas unitarias y de integración |
| Tool Gateway, output guard, léxico de seguridad | Real | La plantilla de seguridad es **provisional, pendiente de aprobación técnica** |
| MaintenanceAdvisor con `ScriptedLlm` | **Simulado** | Reglas deterministas, no IA generativa (por defecto) |
| MaintenanceAdvisor con `AnthropicLlm` | Implementado, **sin prueba en vivo** | SDK oficial, `claude-opus-5-5` configurable; se activa con `LLM_PROVIDER=anthropic` |
| Taller: catálogo, cotización, cupos, reserva, folio, órdenes de trabajo | **MOCK** (`MockWorkshopAdapter`/`MockWorkshopSystem`) | Precios ficticios; para producción hace falta la API o el DMS del taller (contrato en `src/integrations/ports/workshop.ts`) |
| CRM | **MOCK** (`MockCrmAdapter`) | Para producción: integración con el CRM de la agencia (`ports/crm.ts`) |
| Mensajería y recordatorios (WhatsApp, etc.) | **MOCK**, nunca envía (`MockNotificationPort`) | Para producción: BSP de WhatsApp con plantillas aprobadas y consentimiento por canal |
| Identidad | **Simulada**: sesión demo firmada (HMAC) | Para producción: OTP o SSO detrás de la misma interfaz |
| Personas, vehículos, talleres, precios, historial | **Sintéticos** (`dataOrigin=SYNTHETIC`) | No hay datos personales reales |

### 4.1 Dependencias de integración para operar con clientes reales (decisión D4)

El presupuesto de integración del modelo (`Costos` H34: «Integración CRM/DMS + QA», 12 M COP) se mantiene **provisionalmente sin cambios**. Estas son las dependencias que debe cubrir; el costo real de cada una es una hipótesis a validar con TI del cliente (PRD §14, decisión 5):

| Dependencia | Puerto del prototipo | Qué se necesita del cliente | Riesgo si no está |
|---|---|---|---|
| **CRM/DMS** (clientes, vehículos, historial, órdenes) | `ports/crm.ts`; lectura de historial y órdenes vía `ports/workshop.ts` | API o exportación con historial de servicio y procedencia, titularidad vigente y consentimiento; credenciales de servicio con mínimo privilegio | Sin historial verificable, más casos UNKNOWN y derivaciones |
| **Agenda y cotizador del taller** | `ports/workshop.ts` (catálogo, cupos, reserva idempotente, folio, reconciliación) | API de disponibilidad y reserva con idempotencia, catálogo con precios netos e IVA, códigos de servicio | Doble reserva o precios no verificables: no se puede operar |
| **Autenticación del propietario** | Sesión firmada (hoy simulada) | OTP por canal consentido o SSO del cliente, vinculado a titularidad vigente | Riesgo de acceso indebido a datos de un vehículo |
| **Mensajería (WhatsApp/BSP)** | `ports/notifications` (hoy MOCK, nunca envía) | BSP contratado, plantillas aprobadas por categoría y consentimiento por finalidad y canal (Ley 1581) | Sin contacto saliente autorizado; solo canal propio |

## 5. Declaración corta de uso de IA

Se usaron herramientas de IA generativa: ChatGPT para la exploración de producto, la revisión de fuentes, el modelo financiero y el resumen ejecutivo, y Claude Code para la arquitectura y la implementación asistida del prototipo por fases, con pruebas automatizadas. La IA no se usó como fuente de intervalos de mantenimiento ni para certificar nada mecánicamente. Los intervalos, vehículos, precios e integraciones de la demo son sintéticos o simulados y así se rotulan. Los resultados de las pruebas provienen de comandos ejecutados y deben contrastarse con el código y la demo. Las decisiones finales son del autor. La declaración extendida está en `prd/Declaracion_Uso_IA_Vehicle_Care.md`.

## 6. Checklist de criterios de aceptación (PRD §11)

| AC | Criterio | Estado | Evidencia |
|---|---|---|---|
| AC01 | Elegir un vehículo sintético y consultar su perfil | ✅ | Portada → escenario → portal (`*-A1-portal`) |
| AC02 | Estado, motivo, unidad, regla y `plan_version` | ✅ | «Regla aplicada»: intervalo, plan, fuente y versión del motor (`*-A1-portal`) |
| AC03 | `UNKNOWN` sin intervalo inventado | ✅ | Escenario B; eval `B-intervalo-directo` (0 km no respaldados) |
| AC04 | La UI muestra qué consultó el asistente, sin información privada | ✅ | Trazas (`*-A4-trazas`); placa enmascarada; prueba de ausencia de token |
| AC05 | Solo precios del catálogo | ✅ | Eval: 0 precios no respaldados, incluso ante inyección («$99.000») |
| AC06 | Reserva solo con aprobación explícita y respuesta exitosa | ✅ | Botón propio de la tarjeta; el agente no puede confirmar (eval `A-confirma-tu`: 0 reservas sin clic); confirmación idempotente |
| AC07 | Historial incierto → caso humano trazable | ✅ | Escenario B y bandeja |
| AC08 | Seguridad interrumpe el journey comercial y deriva | ✅ | Escenario C; eval: 4/4 detectados, 0 falsos positivos en 8 casos sin riesgo |
| AC09 | Conflicto de cupo sin reservas duplicadas | ✅ | Escenario D; E2E de confirmación duplicada |
| AC10 | Sin consentimiento no hay campaña saliente | ✅ (backend) | `reminders.integration.test.ts` («sin consentimiento: SUPPRESSED…»). No tiene pantalla en la demo |
| AC11 | Historial distingue taller, declarado y simulado | ✅ | Insignias de procedencia y sello «Sintético» en el historial |
| AC12 | Panel de trazas, estado del workflow y responsable | ✅ | `/trazas/[id]` |
| AC13 | Usable en móvil y escritorio; accesible | ✅ | E2E en ambos viewports; axe WCAG 2.1 AA sin violaciones en 5 vistas (`prd/reports/evidence/a11y/`) |
| AC14 | Documentar qué es mock y qué requiere producción | ✅ | Sección 4 de este documento |

## 7. Decisiones aprobadas (2026-10-29) e inconsistencias

La auditoría completa está en `prd/AUDITORIA_CONSISTENCIA.md` (14 diferencias, verificación de fórmulas y sensibilidad). Decisiones del usuario, aplicadas sin modificar el Excel ni las proyecciones:

| # | Decisión | Dónde se refleja |
|---|---|---|
| D1 | **Claude Sonnet 4.6 se mantiene como hipótesis del modelo financiero.** La demo sigue con **ScriptedLlm**, identificado como simulación. **No se afirma la validación de un LLM real.** El adaptador del prototipo es configurable (por defecto `claude-opus-5-5`; sensibilidad en el VPN base de −0,6 M COP) | Nota del PDF p. 2; §4 y §8 |
| D2 | **780 COP por conversación es una estimación, nunca una medición** | Nota del PDF p. 2; guion de demo |
| D3 | **Ticket base 450.000 COP sin cambios.** Sensibilidad: con 280.000 COP netos, **VPN base ≈ −95,5 M COP** (umbral ≈ 72,3 %), calculada sobre una copia del modelo | Nota del PDF p. 2; auditoría §1 |
| D4 | **Presupuesto de integraciones provisional.** Dependencias de CRM/DMS, agenda, autenticación y mensajería documentadas | §4.1; nota del PDF p. 2 |
| D5 | **Ventana de 180 días = criterio de segmentación del piloto**, no regla técnica del motor (el motor no cambia) | Nota del PDF p. 2 |
| D6 | **El protocolo de seguridad requiere aprobación de un responsable técnico antes de operar con clientes reales.** Hoy la plantilla es provisional | Nota del PDF p. 2; `prd/DESPLIEGUE.md` §0; bloqueos §9 |

**Resueltas en documentación:** distinción entre MOCK y real, P0 sin pantalla, A/B e indicadores como diseño del piloto, y consistencia de la declaración de uso de IA.

## 8. Estado real

| Aspecto | Estado |
|---|---|
| **Despliegue** | **No desplegado; no hay URL.** El build es apto para Vercel: compila sin secretos ni base. Pasos exactos en `prd/DESPLIEGUE.md` |
| **LLM** | **Solo `ScriptedLlm`** (simulación determinista, rotulada). `AnthropicLlm` implementado y revisado contra la referencia del SDK, **nunca ejecutado contra la API**. Calidad conversacional, latencia y costo reales sin medir |
| **Pruebas** | lint, typecheck, unitarias, integración, journeys, E2E y axe, build y migraciones en verde (`prd/reports/REPORT_FASE_7.md` §5; cierre en `prd/reports/REPORT_CIERRE.md`) |

## 9. Bloqueos que requieren intervención del usuario

1. **Despliegue público:** cuenta de Vercel (`vercel login`), Postgres del Marketplace en plan gratuito y ejecución de `prd/DESPLIEGUE.md`. Mientras tanto, la demostración es local (`prd/GUIA_DEMO.md` §1) y puede grabarse con el guion de §3.
2. **LLM real (opcional):** `ANTHROPIC_API_KEY` y aprobación de presupuesto (USD 5–10) para `EVAL_LLM=anthropic EVAL_BUDGET_USD=… pnpm eval:agent`. Hasta entonces, D1 y D2 rigen.
3. **Antes de clientes reales (no para la evaluación):** aprobación del protocolo de seguridad por un responsable técnico (D6) y las dependencias de integración de §4.1 (D4).
4. **Grabación del video:** la debe hacer una persona; no hay URL ni video generados.
