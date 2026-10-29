# Auditoría de consistencia — prototipo frente a PRD, resumen ejecutivo y modelo financiero

**Fecha:** 2026-10-29 · **Documentos revisados:**
- `prd/PRD_Vehicle_Care_v1.md` (§4 alcance, §11 AC, §12 métricas, §13 roadmap, §14 decisiones);
- `prd/Vehicle_Care_Resumen_Ejecutivo_Comite.pdf` (2 páginas A4);
- `prd/vehicle_care_finanzas.xlsx` (12 hojas);
- el prototipo (código, pruebas y `prd/ENTREGA.md`).

> **Regla de lectura.** El modelo financiero es una **proyección con supuestos de una agencia ficticia**. El prototipo es una **demostración técnica con datos sintéticos y sistemas simulados**. Ninguna cifra del prototipo es un resultado observado de mercado ni del piloto, y ninguna cifra del modelo fue medida con el prototipo. **No se modificó ni el modelo financiero ni el resumen ejecutivo.**

## 1. Verificación del modelo financiero (reproducibilidad)

| Prueba | Método | Resultado |
|---|---|---|
| Fórmulas visibles y supuestos separados | Inventario con `openpyxl` | `Supuestos` contiene 96 constantes y 0 fórmulas. Los cálculos están en `Pesimista`, `Base` y `Optimista` (176 fórmulas cada una), `COMITE` (49), `Cohortes` (93), `Sensibilidad` (85), `Mercado` (9) y `Costos` (4) |
| Consistencia de los valores guardados | Recálculo independiente de **768 celdas con fórmula** (librería `formulas`, sobre una copia) comparado con los valores almacenados | **0 diferencias** (tolerancia relativa 1e-9) |
| Cifras del resumen ejecutivo | Contraste con `COMITE` | Coinciden: VPN −242,5 M / −46,7 M / +386,2 M; OT 78 / 1.128 / 3.434; CAPEX 91 M / 70 M / 66,5 M; payback 0,79 años (optimista); umbral de tratamiento 53,3 %; costo de IA 780 COP por conversación |
| Fórmula del costo de IA | `Costos!B30 = ((B26/1e6·B24) + (B27/1e6·B25)) · B28 · (1+B29)` | (25.000·3 + 5.000·15)/1e6 USD · 4.000 COP/USD · 1,3 = **780 COP**. Es una **estimación**: tokens H45–H46 son «hipótesis de uso», el FX H47 es un supuesto y el overhead H48 es 30 % |

**Sensibilidad calculada sobre una copia** (entradas sustituidas en memoria; el archivo no cambia). Los precios por token de los modelos 5.5 vienen de la referencia del SDK de Anthropic y deben confirmarse en la página oficial de precios:

| Variante | IA COP/conversación | VPN base | Costo total 3 años, base | Umbral de tratamiento |
|---|---|---|---|---|
| Modelo actual (Sonnet 4.6, USD 3/15) | 780 | −46,7 M | 209,5 M | 53,3 % |
| Opus 5.5 (USD 4/20), modelo por defecto del prototipo | 1.040 | −47,3 M | 210,2 M | 53,4 % |
| Sonnet 5.5 (USD 2/10) | 520 | −46,2 M | 208,7 M | 53,2 % |
| Opus 5.5 con el doble de tokens (50k/10k) | 2.080 | −49,5 M | 213,3 M | 53,8 % |
| Ticket base 280.000 (precio sintético de la demo, neto de IVA) | 780 | **−95,5 M** | 209,5 M | **72,3 %** |

**Lectura:** el modelo de LLM elegido mueve el VPN base cerca de un 1 % a 6 %, mientras que el ticket lo mueve un 104 %. La decisión crítica para el comité es el **ticket real del primer mantenimiento**, no la tarifa del LLM.

## 2. Tabla de diferencias

Severidad:
- **Alta:** podría inducir al comité a tomar una hipótesis como hecho o cambia una conclusión.
- **Media:** genera confusión o requiere una decisión.
- **Baja:** informativa.

| # | Severidad | Diferencia | Evidencia | Propuesta de corrección | Documento afectado | Estado |
|---|---|---|---|---|---|---|
| 1 | Media | El modelo presupuesta **Claude Sonnet 4.6** (USD 3/15 por MTok); el prototipo usa por defecto **`claude-opus-5-5`** | `Costos!B23:B25`, `Fuentes S04`, nota al pie del PDF p. 2 («modelo a revalidar»); `src/infra/container.ts` (`LLM_MODEL ?? "claude-opus-5-5"`) | Decidir el modelo del piloto. Opción a: fijar `LLM_MODEL` al presupuestado en el piloto (el adaptador es configurable). Opción b: actualizar `Costos!B23:B25` con la tarifa oficial vigente. El impacto en el VPN base es de −0,6 M COP (§1) | Modelo (`Costos`, `Fuentes`), PDF p. 2 | **Abierta: decisión del usuario.** Documentada aquí y en `ENTREGA.md` |
| 2 | **Alta** si se presenta como dato observado; si no, Baja | Los **780 COP por conversación** no están medidos: no se ha ejecutado ningún LLM real | `Costos!B26:B29` marcados como hipótesis; `prd/reports/evidence/agent-eval-scripted.json` registra tokens = 0 porque ScriptedLlm no consume; `REPORT_FASE_7.md` §1 | Presentarlo siempre como «estimado». El PDF ya dice «IA estimada». Medirlo con `EVAL_LLM=anthropic EVAL_BUDGET_USD=… pnpm eval:agent` y llevar el resultado a `Costos!B26:B27` (plan `Validacion H17–H23`, mes 2–3) | PDF p. 2, `COMITE!K11` | **Abierta: requiere API key y presupuesto.** Rotulado como estimación en todos los documentos del prototipo |
| 3 | Media | El **ticket neto promedio por OT de 450.000 COP** (base) frente a la **cotización sintética de 333.200 COP con IVA** (280.000 neto) del primer cambio de aceite en la demo | `Supuestos!C18` (330k/450k/560k, «OT/facturación neta de IVA»), PDF p. 2; catálogo MOCK del seed (`SYNTHETIC-DEMO`), captura `A2-intencion` | No son comparables: uno es el promedio por OT y el otro un precio ficticio de un servicio. Ninguno es observado. Validar el ticket real del **primer** mantenimiento (`Validacion H14`). Con 280.000 el VPN base pasa a −95,5 M y el umbral a 72,3 % (§1), así que conviene mostrarlo al comité como sensibilidad | Modelo (`Supuestos`, `Sensibilidad`), PDF p. 2 | **Abierta: validación con el cliente.** Diferencia documentada, sin cambiar cifras |
| 4 | Media | El PDF describe «consulta CRM / catálogo / agenda; el taller confirma cupo; se registra folio» como funcionamiento del sistema; en el prototipo **todo eso es MOCK** | PDF p. 2 «Arquitectura de decisión»; `src/integrations/mock/*`; sellos «Taller simulado» y «Catálogo simulado» en la interfaz | En la presentación, decir «en el prototipo, con sistemas simulados». Para producción, el inventario de `ENTREGA.md` §4 lista lo necesario | PDF p. 2 (redacción), guion de la demo | **Resuelta en la entrega:** inventario MOCK/real, rótulos en la UI y guía de demo |
| 5 | Media | La **CAPEX de integración** (`Costos` H34: «Integración CRM/DMS + QA», 12 M, «conectores mock») no tiene líneas explícitas para la agenda o API del taller, la autenticación OTP/SSO ni el alta en un BSP de WhatsApp. El prototipo los requiere en producción | `Costos!A4:B9`; `ENTREGA.md` §4 | Desglosar H34 o agregar supuestos para la agenda del taller, identidad y BSP. Validar con TI del cliente (PRD §14 decisión 5) | Modelo (`Costos`) | **Abierta: decisión del usuario** |
| 6 | Media | El PRD §4 lista como P0 «alta de vehículo y contexto de entrega», «consentimiento y preferencias» y «bitácora del servicio realmente ejecutado». El prototipo los implementa en **backend** (casos de uso, pruebas de integración) pero **sin pantalla** | `src/application/{record-odometer,workshop/*}.ts`, `reminders.integration.test.ts`, `workshop-ops.integration.test.ts`; la demo no muestra pantallas de consentimiento ni de taller | Declararlo en la entrega: «cubierto por la API y las pruebas; sin interfaz». Ya figura en `ENTREGA.md` §6 (AC10) y en las limitaciones | PRD §4 frente a la entrega | **Resuelta en la entrega** (documentada) |
| 7 | Baja–Media | El modelo y el resumen se enfocan en «primeros 180 días» (`Supuestos` «% con primer servicio exigible ≤180 días»). El prototipo **no filtra la elegibilidad por antigüedad de la entrega** | `Supuestos!A12:D12`, PDF p. 1; el motor no tiene regla de 180 días | Tratarlo como regla de segmentación del piloto (selección de cohortes en CRM), no del motor. Si debe ir al MVP, es una funcionalidad nueva que queda fuera de esta entrega | Modelo, PDF p. 1 | **Abierta: decisión del usuario** |
| 8 | Baja | Modelo y PRD §12 parten de un **A/B con grupo control** (22 % frente a 45 %). El prototipo no asigna grupos ni mide uplift | `Supuestos!C16:C17`, `COMITE!B26`, PRD §12 | Es diseño del piloto (mes 3), no del MVP. El prototipo deja eventos del journey y auditoría que permiten instrumentar el funnel. Aclararlo al comité | PRD §12–13 | Documentada |
| 9 | Baja | **Indicadores del PRD §12:** el prototipo no tiene un tablero de métricas. Sí mide de forma verificable en evaluación falsas confirmaciones (0), handoff correcto y precios inventados (0), siempre con ScriptedLlm | `agent-eval-scripted.json`; eventos en `JourneyEvent` y `AuditLog` | Presentarlo como «instrumentación disponible», no como métricas del piloto | PRD §12 | Documentada |
| 10 | Baja | La **tasa de derivación a humano** del modelo (20/12/8 %) es una hipótesis. Los 2 de 12 casos de la evaluación son casos diseñados, no una tasa | `Supuestos!B25:D25`; `agent-eval-scripted.json` | No usar el prototipo para calibrar la tasa; medirla en el piloto | Modelo | Documentada |
| 11 | Media | La **plantilla de seguridad** del prototipo está rotulada como provisional, «pendiente de aprobación por personal técnico». El PRD §14 (decisión 4) deja abierto quién aprueba los protocolos | Texto de la plantilla en la captura `C1-seguridad` | Asignar un responsable técnico que apruebe el texto antes del piloto (compuerta del mes 1) | PRD §14, prototipo | **Abierta: decisión del cliente** |
| 12 | Baja | El PRD §13 (mes 1) pide «2–3 planes técnicos aprobados»; el prototipo trae 1 plan **sintético** (`demo-2026.10-r1`) | Seed, sello «Regla sintética de demo» | Consistente como hipótesis; no presentarlo como plan de fabricante | — | Consistente |
| 13 | Baja | El resumen menciona una red de 8 sedes; la demo tiene 2 talleres sintéticos | `Supuestos!B5`; seed T1/T2 | Informativa (escala de la demo) | — | Consistente |
| 14 | Baja | **Declaración de uso de IA:** PDF p. 2, `Declaracion_Uso_IA_Vehicle_Care.md` y PRD «Declaración corta» | Las tres nombran o describen ChatGPT y Claude Code con revisión humana | Sin cambios. `ENTREGA.md` §5 resume las tres sin contradicción | — | Consistente |

## 3. Resumen

- **Resueltas en esta entrega** (documentación, sin cambiar cifras): 4, 6, 8, 9, 10, 12, 13 y 14.
- **Abiertas, requieren intervención del usuario:**
  - 1: modelo de LLM del piloto;
  - 2: medición real del costo de IA (API key y presupuesto);
  - 3: ticket real;
  - 5: CAPEX de integraciones;
  - 7: regla de 180 días;
  - 11: aprobación de la plantilla de seguridad.
- **Cambio sugerido opcional al PDF:** en la nota al pie de la p. 2, agregar «prototipo con sistemas simulados; LLM configurable (por defecto Opus 5.5); costo de IA estimado, no medido». Solo con aprobación del autor.
