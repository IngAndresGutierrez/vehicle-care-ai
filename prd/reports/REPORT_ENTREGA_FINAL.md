# Informe de entrega final — aplicación de decisiones del comité

**Fecha:** 2026-10-29 · **Alcance:** solo documentación y notas del resumen ejecutivo. Sin funcionalidades, agentes ni integraciones reales nuevas. El Maintenance Engine y el Excel no cambiaron. No se crearon recursos de pago ni se ejecutó un LLM real.

## 1. Decisiones aplicadas (D1–D6)

| # | Decisión | Aplicación |
|---|---|---|
| D1 | Sonnet 4.6 como hipótesis del modelo; demo con ScriptedLlm rotulado; no se afirma validación de un LLM real | Nota del PDF p. 2; `ENTREGA.md` §7; guion (frase de apertura); política de despliegue §0.2 |
| D2 | 780 COP por conversación = estimación, nunca medición | Nota del PDF p. 2; guion (cierre) |
| D3 | Ticket base 450.000 COP; sensibilidad 280.000 COP → VPN base ≈ −95,5 M COP | Nota del PDF p. 2 (agrega el umbral ≈ 72,3 %); guion (cierre); auditoría §1 |
| D4 | Presupuesto de integraciones provisional; dependencias documentadas | `ENTREGA.md` §4.1 (CRM/DMS, agenda y cotizador, autenticación, mensajería); nota del PDF p. 2 |
| D5 | 180 días = segmentación del piloto, no regla del motor | Nota del PDF p. 2; motor sin cambios |
| D6 | Protocolo de seguridad aprobado por un responsable técnico antes de clientes reales | Nota del PDF p. 2; `DESPLIEGUE.md` §0.1; guion (escenario C); `ENTREGA.md` §9 |

## 2. Resumen ejecutivo: qué cambió y cómo se verificó

- **Cambio:** solo dos bloques de notas de la p. 2.
  - La nota gris bajo «Caso de negocio» agrega la sensibilidad del ticket.
  - «Fuentes y método / Uso de IA» agrega las hipótesis, el prototipo simulado con sus dependencias, ScriptedLlm, los 180 días y la aprobación de seguridad.
- **Herramienta:** `prd/tools/actualizar_notas_resumen.py` (PyMuPDF). Redacta el texto original, de modo que se elimina y no solo se tapa, y reescribe con la misma fuente (DejaVu Sans), color (#506274) y tamaño original (7,45 pt y 6,9 pt). Falla si el texto no cabe o si el resultado no tiene 2 páginas.
- **Verificación:**

| Prueba | Resultado |
|---|---|
| `pdfinfo` | **2 páginas** A4 |
| Comparación de píxeles a 100 dpi frente al original | **0 píxeles distintos fuera de los dos bloques**, en ambas páginas |
| Texto de la p. 1 | Idéntico |
| Texto de la p. 2 fuera de las notas | Idéntico |
| Cifras de proyección (−242,5 M, −46,7 M, +386,2 M, 1.128 OT, 70 M, 0,79 años, 450.000, 780 COP, 53,3 %) | Presentes y sin cambios |
| Texto de la nota anterior | Eliminado |

- **Trazabilidad:** el original está en `prd/historico/Vehicle_Care_Resumen_Ejecutivo_Comite_v1.0_2026-10-28.pdf` y los metadatos del nuevo PDF registran la revisión.
- **Sensibilidad 280.000 COP:** proviene del recálculo independiente sobre una **copia** del Excel (auditoría §1); el Excel no se editó.

## 3. Validaciones ejecutadas en esta etapa

| Validación | Resultado |
|---|---|
| `pnpm lint` / `pnpm typecheck` | exit 0 / exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test:e2e` (A–D, seguridad, axe; escritorio y móvil) | **25/25** (`prd/reports/evidence/e2e-entrega-final.txt`) |
| Excel | Sin cambios frente al repositorio (`git diff` vacío); recálculo previo: 768 fórmulas, 0 diferencias |
| Consistencia del paquete | Todas las rutas citadas en README, ENTREGA, GUIA_DEMO, DESPLIEGUE, AUDITORIA y REPORT_CIERRE existen |

Las suites unitaria, de integración y de journeys no se volvieron a ejecutar porque el código no cambió en esta etapa. Su último resultado, sobre el mismo código (`REPORT_CIERRE.md` §6), fue 180/180, 169/169 y 13/13.

## 4. Archivos del paquete final

| Archivo | Rol |
|---|---|
| `prd/ENTREGA.md` | **Índice del paquete**: entregables, evidencia, inventario MOCK/real, dependencias (§4.1), declaración de IA, checklist AC01–AC14, decisiones D1–D6, estado real y bloqueos |
| `prd/Vehicle_Care_Resumen_Ejecutivo_Comite.pdf` | Entregable 02: resumen ejecutivo de 2 páginas, con notas rev. 29 oct 2026 |
| `prd/vehicle_care_finanzas.xlsx` | Entregable 03: modelo financiero, intacto |
| `prd/Declaracion_Uso_IA_Vehicle_Care.md` | Declaración extendida de uso de IA; la corta está en `ENTREGA.md` §5 |
| `README.md`, `src/`, `prisma/`, `tests/`, `scripts/`, `.env.example` | Entregable 01: prototipo |
| `prd/GUIA_DEMO.md` | Demostración local reproducible, guía de presentación y guion de grabación (4:50) |
| `prd/DESPLIEGUE.md` | Política, auditoría y pasos exactos para Vercel con Postgres gestionado |
| `prd/AUDITORIA_CONSISTENCIA.md` | 14 diferencias, verificación de fórmulas, sensibilidad y decisiones |
| `prd/historico/Vehicle_Care_Resumen_Ejecutivo_Comite_v1.0_2026-10-28.pdf` | PDF original |
| `prd/tools/actualizar_notas_resumen.py` | Script reproducible del cambio de notas |
| `prd/reports/REPORT_FASE_0_1.md` … `REPORT_FASE_7.md`, `REPORT_CIERRE.md`, este informe | Informes |
| `prd/reports/screenshots/` (24 PNG), `prd/reports/evidence/` | Evidencia: E2E, axe, evaluación agéntica, recorridos de API |
| `prd/PRD_Vehicle_Care_v1.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `AGENT_DESIGN.md`, `IMPLEMENTATION_PLAN.md`, `prd/adr/` | Producto y arquitectura |

## 5. Enlaces reales disponibles

- **Ninguna URL pública:** no hay despliegue ni video publicado.
- **Repositorio git local:** sin remoto configurado.
- **Demo local:** `http://localhost:3000`, solo tras ejecutar `prd/GUIA_DEMO.md` §1.

## 6. Bloqueos restantes

1. **Despliegue público:** requiere cuenta de Vercel (`vercel login`) y crear Postgres en plan gratuito; después, ejecutar `prd/DESPLIEGUE.md`.
2. **Video:** la grabación con el guion de `GUIA_DEMO.md` §3 la debe hacer una persona.
3. **LLM real (opcional):** requiere `ANTHROPIC_API_KEY` y aprobación de presupuesto. Hasta entonces rigen D1 y D2.
4. **Antes de clientes reales**, fuera del alcance de la evaluación: aprobación del protocolo de seguridad (D6) e integraciones de `ENTREGA.md` §4.1 (D4).
5. **Remoto git:** si el paquete se entrega como repositorio, falta configurar un remoto o generar un archivo comprimido. No se hizo sin autorización.
