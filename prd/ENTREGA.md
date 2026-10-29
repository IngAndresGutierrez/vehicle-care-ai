# Vehicle Care — Paquete de entrega (MVP)

**Fecha:** 2026-10-29 · **Alcance:** primer mantenimiento postventa (Colombia). Todos los datos son **sintéticos**; taller, CRM y mensajería son **simulados (MOCK)**.

> **Estado del LLM:** la demo y todas las pruebas usan `ScriptedLlm`, una **simulación determinista por reglas que no es IA generativa** y así aparece rotulada en la interfaz. El adaptador de Anthropic está implementado y revisado contra la referencia del SDK, pero **no se ha ejecutado contra la API**: no hay `ANTHROPIC_API_KEY` ni autorización de gasto. No se declara probado un LLM real.

## 1. Cómo ejecutarlo

**URL pública: no publicada.** No hay credenciales de Vercel en el entorno. Los pasos de despliegue están en el README, sección «Despliegue en Vercel».

Ejecución local reproducible (requiere Node ≥ 24, pnpm y Docker):

```bash
pnpm install && cp .env.example .env      # DEMO_MODE=true, LLM_PROVIDER=scripted
pnpm db:up && pnpm db:migrate:deploy && pnpm db:seed
pnpm build && pnpm start                  # http://localhost:3000
```

Guía de la demo: README, sección «Demo navegable».

## 2. Evidencia de los cuatro escenarios

Prueba automatizada con Playwright sobre `next start`, en escritorio (1440×900) y móvil (Pixel 7). Registro: `prd/reports/evidence/e2e-fase7.txt` (25/25).

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

## 7. Inconsistencias con el modelo financiero y el resumen ejecutivo (para revisión; no se modificaron)

| # | Documento | Supuesto | Prototipo | Sugerencia |
|---|---|---|---|---|
| 1 | Modelo financiero (`Costos!B23:B30`, `Fuentes S04`) y resumen ejecutivo | Claude **Sonnet 4.6**, USD 3/15 por MTok, 25.000/5.000 tokens por conversación → **780 COP/conversación** | Modelo por defecto **`claude-opus-5-5`**. La referencia del SDK indica USD 4/20 por MTok, lo que da un costo por token mayor | Elegir el modelo del piloto y actualizar la tarifa con la página oficial de precios. Los tokens por conversación **no están medidos**: medirlos con `EVAL_LLM=anthropic pnpm eval:agent` |
| 2 | Modelo (`Supuestos!B18:D18`, «Ticket neto» 330k/450k/560k COP) | Ticket neto de IVA por OT | Catálogo **sintético** para el primer cambio de aceite: 280.000 neto (333.200 con IVA) | Son cifras ficticias en ambos lados. Validar el ticket real del primer mantenimiento con el taller (`Validacion` H14) |
| 3 | Modelo («Cohortes de entregas ≤180 días») y resumen («foco primeros 180 días») | Elegibilidad por antigüedad de la entrega | El prototipo evalúa cualquier vehículo con plan validado; **no filtra por 180 días** | Definir si la regla de elegibilidad entra al MVP o queda como segmentación operativa del piloto |
| 4 | Modelo (`Supuestos` A/B: control 22% vs tratamiento) y resumen («Piloto A/B») | Grupo de control | El prototipo no asigna grupos ni mide uplift | Es trabajo del piloto (M3), no del MVP; conviene aclararlo ante el comité |
| 5 | Modelo («% derivaciones a humano» 20/12/8%) | Tasa de excepciones | Solo hay datos sintéticos (eval: 2/12 casos con caso humano por diseño) | Ninguna cifra del prototipo sirve para calibrar esta tasa |
| 6 | Resumen ejecutivo, journey paso 05 «Taller: orden y registro de servicio» | Orden de trabajo y registro | Existe en el backend (casos de uso y pruebas de la Fase 4), **sin pantalla** en la demo | Presentarlo como cubierto por la API y las pruebas, no por la interfaz |
| 7 | Modelo («Tarifa por mensaje» 45 COP, WhatsApp) | Canal WhatsApp | La mensajería es MOCK y no envía | Coherente con el alcance; mantener la etiqueta de hipótesis |
