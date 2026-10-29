# Informe — Fase 6 (experiencia visual, integración con la API y demo navegable)

**Fecha:** 2026-10-29 · **Alcance:** solo Fase 6. Sin SOAT, seguros ni RUNT. Sin agentes nuevos. Sin integraciones reales de WhatsApp, CRM ni talleres. **El Maintenance Engine y sus reglas no se modificaron.**

> **Sobre el LLM.** Toda la demo, todos los E2E y todas las capturas usan `ScriptedLlm`: **simulación determinista por reglas, no IA generativa**. La interfaz lo rotula así en la cabecera, en el asistente y en cada respuesta. Se agregó una prueba con el LLM real de Anthropic (`tests/evals/live-anthropic.eval.test.ts`), pero **no se ejecutó**: no hay `ANTHROPIC_API_KEY` en el entorno y quedó *skipped*. No se declara probado ningún LLM real.

## 1. Validación (comandos ejecutados sobre el código final)

| Comando | Resultado real |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (unitarios) | exit 0, **180 tests** (sin cambios) |
| `pnpm test:integration` | exit 0, **12 archivos, 167 tests** (160 previos + 7 nuevos en `views-demo.integration.test.ts`) |
| `pnpm test:journeys` | exit 0, 13 tests |
| `pnpm test:coverage` (`src/domain`) | 99,8 % stmts · 97,2 % ramas · 100 % funciones · 100 % líneas |
| `pnpm db:verify-migrations` | 10 migraciones desde cero, «No difference detected», seed aplicado, base eliminada. **No se agregaron migraciones.** |
| `pnpm build` | exit 0. `/`, `/casos` estáticas; `/vehiculo/[id]`, `/trazas/[id]` con prerender parcial; todas las API dinámicas (incluida `/api/demo/config`) |
| `pnpm test:evals` | 2 tests **skipped** (sin API key) |
| `pnpm test:e2e` (Playwright, Chromium) | exit 0, **22 tests**: 13 de escritorio (1440×900) y 9 en móvil (Pixel 7). Registro en `prd/reports/evidence/e2e-fase6.txt` |

## 2. Evidencia de los cuatro escenarios (Playwright sobre `next start`)

Capturas en `prd/reports/screenshots/{desktop,mobile}-*.png`, 12 por viewport.

| Escenario | Lo que verifica el E2E | Capturas |
|---|---|---|
| **A. Éxito → folio** | Odómetro, frase «Toca a los 75.000 km…», sello «Regla sintética de demo» → evaluación → cotización 333.200 COP (catálogo simulado) → horarios (agenda simulada) → tarjeta de reserva con cuenta regresiva y «El asistente no puede confirmar por ti» → **clic del usuario** → «Reserva confirmada por el taller. Folio FOLIO-T1-DEMO-…» → estado «Reservado» → folio en «Tu cita» → trazas: herramientas con fuente «Sistema simulado», «Eventos y estado coinciden», sin `confirmationToken` en la página | `A1-portal`, `A2-intencion`, `A3-confirmada`, `A4-trazas` |
| **B. Historial insuficiente** | Correa: «No hay datos suficientes… no se inventa un intervalo» y el motivo «No hay constancia de un servicio anterior» → turno → tarjeta «Caso para un asesor», sin cotización → asesor: caso «Historial insuficiente» asignado a «Tú» → «Resolver caso → Cerrar el caso» con nota → sale de «Abiertos» | `B1-caso-humano`, `B2-bandeja` |
| **C. Seguridad** | «El freno se hunde…» → tarjeta «Atención por seguridad» y aviso «El asistente dejó de actuar» → estado «Escalado por seguridad» → «cotízame» no produce cotización ni reserva → asesor: prioridad urgente y «El asistente está detenido» → «Habilitar el agendamiento» → trazas con «Señal de seguridad» y «Caso resuelto por una persona» | `C1-seguridad`, `C2-bandeja-urgente`, `C3-trazas` |
| **D. Conflicto de cupo** | Hasta la tarjeta de reserva → «Simular que otro cliente tomó el cupo» → confirmar → «Otro cliente tomó ese horario… No se creó ninguna reserva» → sugerencia «¿Qué horarios hay?» → nuevo horario → confirmar → folio | `D1-conflicto`, `D2-nueva-confirmacion` |

**Seguridad y errores** (`tests/e2e/security.spec.ts` y `tests/integration/views-demo.integration.test.ts`):

- **Confirmación duplicada.**
  - Dos confirmaciones concurrentes con el mismo token producen **un solo `bookingId`**; la tercera responde `duplicate: true`.
  - En la UI, el doble clic produce un único aviso de confirmación y el botón desaparece.
- **Acceso cruzado.**
  - Un propietario recibe 403 al pedir el overview, las trazas o un turno sobre un vehículo ajeno, al confirmar con un token ajeno y al usar la bandeja o resolver casos.
  - Sin sesión, la API responde 401.
  - `/api/demo/session` no acepta cuentas que no sean demo (404).
  - Un asesor recibe 403 en el asistente.
- **Compliance.** Ve las trazas solo con justificación, y cada consulta queda en `AuditLog` (`AUDIT_READ`).
- **Entradas inválidas.** Responden 400, 413 o 415 con códigos estables: escenario inexistente, `serviceCode=SOAT`, campos extra y token inexistente (404).
- **Errores en la UI.**
  - Un 500 simulado del asistente muestra «El asistente no pudo responder. Tu información no cambió.» y «Reintentar», que recupera el turno.
  - Un vehículo ajeno muestra «No tienes acceso a este vehículo».
  - Sin sesión, la UI pide iniciar un escenario.
- **DEMO_MODE.** Sin `DEMO_MODE`, los endpoints demo responden 404; existe un límite de corridas por IP (429 con `retry-after`).

## 3. Entregables

**Pantallas:**
- `/`: selector de escenarios con identidades sintéticas.
- `/vehiculo/[id]`: perfil, odómetro, regla de km, estado con fecha/km/regla/fuente, historial con procedencia, cita con folio, y el asistente con tarjetas, sugerencias, confirmación, vencimiento y recuperación. En móvil usa pestañas.
- `/trazas/[id]`: estado, responsable, si el asistente está activo o detenido, consistencia por *replay*, línea de tiempo numerada de eventos y herramientas (fuente MOCK/interno, estado en cada llamada, motivo de rechazo), decisiones del motor y controles de salida.
- `/casos`: bandeja con motivo, prioridad, plazo, responsable, contexto mínimo no verificado, acciones permitidas por estado y aviso de agente detenido.

**Backend:**
- `src/application/views/read-models.ts`, `src/application/demo/demo-runs.ts` y `src/infra/http/view-handlers.ts`.
- 8 rutas nuevas.
- Filtro `vehicleIds` en `runEvaluationJob`.

Las decisiones están en **ADR-019**. Los cambios en README cubren la demo, E2E y el despliegue en Vercel.

## 4. Hallazgos corregidos durante la fase

1. **`/api/demo/config` se prerenderizaba en el build**, lo que congelaba `DEMO_MODE` y el rótulo del LLM. Ahora llama a `connection()`.
2. **La tarjeta de seguridad no se veía:** los avisos `SYSTEM_NOTICE` no pintaban sus tarjetas.
3. **Horarios duplicados:** el calendario de demo coincidía con los horarios del seed. `ensureMockCalendar` ya no duplica, y se eliminó un horario duplicado sin uso de la base de desarrollo.
4. **El calendario simulado se agotaba:** con cupo 3 compartido entre visitantes, Taller Norte quedó sin cupos tras las corridas de prueba. El cupo de demo pasó a 50 (solo datos MOCK; ADR-019 §6). Los horarios de demo futuros de la base de desarrollo se ajustaron al nuevo cupo.
5. **E2E en paralelo:** las reservas competían de verdad por el mismo horario. Ahora corren secuenciales, documentado en `playwright.config.ts`.
6. **Etiquetas:** «Abierto por» mostraba «HUMANO»; ahora muestra el rol real del actor. Se corrigieron dobles puntos en textos de fecha.

## 5. Limitaciones conocidas

- **LLM real no probado.** Solo existe la prueba automatizada, que requiere `ANTHROPIC_API_KEY`. Las respuestas del ScriptedLlm muestran fechas en ISO («2026-10-31 a las 14:00»); las tarjetas sí las formatean.
- **Calendario MOCK compartido entre visitantes:** puede haber conflictos reales, que se manejan igual que el escenario D. La simulación de D deja sin cupo ese horario para todos.
- **Datos que solo crecen:** las corridas agregan filas que no se borran (tablas append-only), acotadas por el límite por IP.
- **Limitador en memoria:** vale por instancia, no es global en serverless.
- **Despliegue en Vercel preparado pero no ejecutado:** la CLI de Vercel no está instalada y no se creó base gestionada.
- **Sin modo oscuro.** La interfaz fija `color-scheme: light`.
- **Accesibilidad:** se cuidaron roles, `aria-live`, foco visible, contraste, `prefers-reduced-motion` y objetivos táctiles de 44 px, pero no se hizo una auditoría automatizada (axe).
- **Trazas de decisión:** los pasos de `decisionTrace` del motor se muestran con sus códigos técnicos (p. ej. `dimension-km: WITHIN_LIMIT`), pensados para auditoría.
