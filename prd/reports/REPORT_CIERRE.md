# Informe de cierre — auditoría final y entrega

**Fecha:** 2026-10-29 · **Alcance:** cierre sin funcionalidades nuevas. Solo se hicieron dos correcciones de despliegue (§3) y documentación. Sin cambios en el Maintenance Engine, en las cifras financieras ni en el PDF. No se ejecutaron pruebas con APIs de pago.

## 1. Checklist de requisitos de la prueba técnica

| Requisito (enunciado) | Estado | Dónde |
|---|---|---|
| **A.** Supuestos de mercado con fuentes reales; segmento de entrada; ecosistema; experiencia end-to-end; qué construir primero | ✅ | PRD §1–§6, resumen ejecutivo p. 1, modelo `Mercado`/`Fuentes` |
| **B.** Arquitectura agéntica: agentes, herramientas, permisos, memoria, handoffs; límites de decisión | ✅ | `AGENT_DESIGN.md`, ADR-018; implementado en `src/agent/` (Tool Gateway con permisos por estado; el agente no puede confirmar) |
| **B.** Controles: privacidad, consentimiento, calidad, trazabilidad, fraude, mensajes adversariales, escalamiento | ✅ | Políticas de acceso y consentimiento, output guard, detección de inyección, léxico de seguridad, auditoría *append-only*, panel de trazas, aislamiento de la demo (ADR-016, ADR-018, ADR-020) |
| **B.** Integración con sistemas | ✅ con MOCK | Puertos y adaptadores (`src/integrations/ports`, `mock`). Inventario MOCK/real en `ENTREGA.md` §4 |
| **C.** Caso de negocio a 3 años: funnel, ingresos, margen, inversión, opex, costos de IA; escenarios; payback; sensibilidad; plan de validación | ✅ | `vehicle_care_finanzas.xlsx` (reproducible, 0 diferencias al recalcular); `Sensibilidad`, `Validacion` |
| **D.** Roadmap de 6 meses con compuertas; indicadores; cambio en equipos; riesgos y decisiones del cliente | ✅ | PRD §12–§14, resumen ejecutivo p. 2, modelo `COMITE` y `Validacion` |
| **01** Prototipo navegable con un journey clave y la intervención visible del agente | ✅ local / ❌ URL | 4 escenarios; tarjetas desde herramientas; trazas. Sin URL pública (§4) |
| **01** Al menos dos caminos de falla o excepción | ✅ (3) | B historial insuficiente, C seguridad, D conflicto de cupo, más errores y recuperación en la UI |
| **01** Visible qué hace el agente, qué consulta y cuándo transfiere | ✅ | Tarjetas con sellos de fuente, `/trazas/[id]` y `/casos` |
| **02** Resumen ejecutivo PDF ≤ 2 páginas con los contenidos pedidos | ✅ | 2 páginas A4 (`pdfinfo`) |
| **03** Hoja reproducible: supuestos separados, fórmulas visibles, fuentes, funnel, capacidad, costos, IA, payback, escenarios, supuestos críticos, sensibilidad, validación | ✅ | `Supuestos` con 96 constantes y 0 fórmulas; 768 fórmulas en hojas de cálculo |
| Declaración corta de uso de IA | ✅ | `ENTREGA.md` §5, PDF p. 2, `Declaracion_Uso_IA_Vehicle_Care.md` |
| Paquete único | ✅ | Repositorio con `prd/ENTREGA.md` como índice |

## 2. Inconsistencias encontradas y resueltas

Detalle completo en `prd/AUDITORIA_CONSISTENCIA.md`.
- **Verificado sin diferencias:** las cifras del PDF (VPN, OT, CAPEX, payback, umbral 53,3 %, 780 COP/conversación) coinciden con `COMITE`. Las 768 fórmulas se recalculan sin diferencias.
- **Resueltas en documentación:**
  - el PDF describe sistemas que en el prototipo son MOCK;
  - tres ítems P0 del PRD existen solo en backend;
  - A/B, indicadores y tasa de derivación son diseño del piloto, no resultados;
  - la declaración de IA es consistente.
- **Abiertas, decisión del usuario:**

| # | Tema | Situación |
|---|---|---|
| 1 | Modelo del LLM | Sonnet 4.6 presupuestado frente a Opus 5.5 por defecto; impacto en el VPN base −0,6 M COP |
| 2 | Costo de IA | 780 COP/conversación **estimados, no medidos** |
| 3 | Ticket | Ticket base 450.000 neto frente a 280.000 neto sintético. Es la variable crítica: VPN base −95,5 M y umbral 72,3 % con 280.000 |
| 5 | CAPEX | Integraciones sin desglosar (agenda del taller, identidad, BSP) |
| 7 | Elegibilidad | Regla de 180 días |
| 11 | Seguridad | Aprobación técnica de la plantilla de seguridad |

## 3. Correcciones de despliegue hechas en el cierre

1. **`prisma generate` fallaba sin `DATABASE_URL`** (postinstall en Vercel o CI). `prisma.config.ts` ahora define el datasource solo si hay URL. Comprobado: `generate` sin URL da ✔ y `migrate status` sin URL da un error claro.
2. **`next build` ejecutaba `GET /api/cases` y exigía `SESSION_SECRET` al compilar.** Las rutas `GET` (`/api/me`, `/api/cases`, `/api/vehicles/[id]/{overview,trace}`) ahora llaman a `connection()`. Comprobado: `next build` sin `.env` termina con exit 0.
3. **Infraestructura de pruebas:** `E2E_BASE_URL` permite correr los 25 E2E contra un despliegue real.

## 4. Estado real del despliegue

**No desplegado. No hay URL.** No hay CLI de Vercel, token ni proyecto vinculado, y no se crearon recursos. La auditoría de configuración (cookies, sesiones, CSRF, cabeceras, límites, Prisma en serverless, secretos) y los pasos exactos están en `prd/DESPLIEGUE.md`.

## 5. Estado real del LLM

**Solo `ScriptedLlm`**, una simulación determinista rotulada en la UI. `AnthropicLlm` está implementado y revisado contra la referencia del SDK para Opus 5.5, pero **nunca se ejecutó contra la API**. Calidad conversacional, latencia, tokens y costo reales: **sin medir**. La evaluación de 12 casos con ScriptedLlm (12/12) valida los controles, no el modelo.

## 6. Validación final (ejecutada sobre el código de este cierre)

| Comando | Resultado |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 180/180 |
| `pnpm test:integration` | 169/169 |
| `pnpm test:journeys` | 13/13 |
| `pnpm db:verify-migrations` | «No difference detected» |
| `pnpm build` | exit 0, también sin `.env` |
| `pnpm test:e2e` | 25/25: A–D, seguridad y axe, en escritorio y móvil (`prd/reports/evidence/e2e-cierre.txt`) |
| `pnpm test:evals` | 2 skipped: no hay API key |

## 7. Archivos del paquete

- **Índice:** `prd/ENTREGA.md`.
- **Guion de demo:** `prd/GUIA_DEMO.md`.
- **Auditoría:** `prd/AUDITORIA_CONSISTENCIA.md`.
- **Despliegue:** `prd/DESPLIEGUE.md`.
- **Este informe:** `prd/reports/REPORT_CIERRE.md`.
- **Entregables de la prueba:**
  - `prd/Vehicle_Care_Resumen_Ejecutivo_Comite.pdf`;
  - `prd/vehicle_care_finanzas.xlsx`;
  - `prd/Declaracion_Uso_IA_Vehicle_Care.md`.
- **Producto y diseño:** `prd/PRD_Vehicle_Care_v1.md`, `prd/ARCHITECTURE.md`, `prd/DATA_MODEL.md`, `prd/AGENT_DESIGN.md`, `prd/IMPLEMENTATION_PLAN.md`, `prd/adr/ADR-009…020`.
- **Evidencia:**
  - `prd/reports/screenshots/` (24 capturas de escritorio y móvil);
  - `prd/reports/evidence/` (registros E2E, evaluación agéntica, axe, recorridos de API, flujo de reserva);
  - `prd/reports/REPORT_FASE_*.md`.
- **Prototipo:** `src/`, `prisma/`, `tests/`, `scripts/`, `README.md`, `.env.example`.

## 8. Bloqueos que requieren intervención del usuario

1. **Despliegue:** `vercel login` y elección del plan de Postgres; después, ejecutar `prd/DESPLIEGUE.md` §2.
2. **LLM real:** `ANTHROPIC_API_KEY` y aprobación de presupuesto (sugerido USD 5–10) para `EVAL_LLM=anthropic EVAL_BUDGET_USD=… pnpm eval:agent`.
3. **Decisiones de negocio:** puntos abiertos 1, 2, 3, 5, 7 y 11 de la auditoría. Ninguna cifra del modelo ni del PDF se cambió.
4. **Opcional:** nota aclaratoria en el PDF (auditoría §3).
