# Informe — Fase 8C (robustez operativa y experiencia end-to-end con Claude real)

**Fecha:** 2026-10-29 · **Alcance:** fiabilidad del software existente y validación de la experiencia completa con Claude. Sin funcionalidades de negocio ni agentes nuevos. **`src/domain` (Maintenance Engine, FSM, políticas) no cambió.** Decisiones en ADR-023.

> Nota: el encargo llegó cortado al final («…comparar»). Se interpretó como comparar el journey completo con ScriptedLlm frente a Claude real (§5).

## 1. Auditoría inicial: riesgos por severidad

| # | Severidad | Riesgo encontrado | Evidencia | Estado |
|---|---|---|---|---|
| 1 | **Alta** | El lease de la Fase 8B no tenía fencing: se liberaba por igualdad de timestamp, usaba el reloj de la instancia y la escritura no verificaba al dueño. Si un turno sobrevivía a su lease, otro podía tomarlo y ambos ejecutaban herramientas | Prueba de toma tras vencimiento | **Corregido:** `TurnLease` con token, hora de la BD, renovación por paso y escritura con fencing |
| 2 | **Alta** | Respuesta perdida tras `prepareBooking`: journey en `AWAITING_CONFIRMATION` (sin herramientas comerciales, correcto) y el propietario **sin token** hasta que la intención venciera | Prueba de sesión nueva tras preparar | **Corregido:** reentrega de la **misma** intención con un token nuevo (mecanismo idempotente existente) |
| 3 | **Alta** | La guardia aceptaba intervalos de **otro servicio** («el aceite cada 100.000 km»), lecturas rechazadas o reemplazadas y planes no vigentes | Prueba con el intervalo de la correa en la conversación del aceite | **Corregido:** hechos acotados (§3) |
| 4 | Media | El portal mostraba la reserva **fallida** en vez de la confirmada tras un conflicto y una recuperación | Prueba de recuperación de cupo | **Corregido:** se muestra la reserva activa del journey |
| 5 | Media | Sin métricas por fase ni costo por turno | — | **Corregido:** observabilidad (§4) |
| 6 | Baja | La UI no indicaba el modelo por mensaje ni orientaba durante esperas de 4 a 8 s | Corrida real desde la UI | **Corregido:** etiqueta, espera progresiva y reintento seguro |

No se refactorizó nada sin defecto medible: gateway, FSM, Maintenance Engine y políticas siguen igual.

## 2. Concurrencia y sesiones (pruebas nuevas)

| Caso | Resultado |
|---|---|
| El lease vence durante un turno lento y otro turno lo toma | El turno viejo recibe `LEASE_LOST`, **no ejecuta** la herramienta que pidió después y **no escribe**; la transcripción queda válida |
| Liberación por un turno distinto | No libera el lease del dueño actual; el token viejo tampoco renueva |
| Toma con la hora de la BD | La toma se decide con `now()` de PostgreSQL (vale entre instancias) |
| Turnos simultáneos | Uno procesa y el otro recibe `TURN_IN_PROGRESS` antes de ejecutar herramientas (Fase 8B, se mantiene) |
| Sesión vencida o cambio de prompt o de modelo | Se abre sesión nueva; una reserva pendiente se reentrega |

## 3. Guardia: hechos acotados (pruebas nuevas)

| Caso | Resultado |
|---|---|
| El intervalo de la correa en la conversación del aceite | **Bloqueado**; el intervalo del aceite pasa |
| El kilometraje real de **otro vehículo** | **Bloqueado**; el del propio vehículo pasa |
| El precio de una cotización **vencida** | **Bloqueado** (`GUARD:UNSUPPORTED_AMOUNT`); vigente pasa |
| Regresión de la corrida real (§5) | 0 bloqueos y 0 falsos positivos nuevos con la guardia acotada |

Se mantienen todas las restricciones sobre precios, intervalos, diagnósticos, confirmaciones y folios.

## 4. Fallos operativos con inyección (pruebas nuevas)

| Fallo | Resultado verificado contra la base |
|---|---|
| Anthropic 429 / 500 / 529 / timeout | Adaptador: respeta `retry-after` y agota los reintentos; turno: `LLM_TIMEOUT`/`LLM_UNAVAILABLE` con trazabilidad (`ERROR:<código>`) |
| Timeout después de ejecutar herramientas | Tarjetas persistidas (sin token), evento de recomendación aplicado, siguiente turno cotiza |
| Respuesta perdida tras preparar la reserva | Misma intención reentregada; token viejo `INVALID_TOKEN`; token nuevo confirma; **1 reserva** |
| El usuario reintenta el mismo turno | 0 intenciones nuevas y 0 reservas |
| La cotización caduca en la conversación | No se prepara nada; volver a cotizar funciona |
| El horario se ocupa antes de confirmar | `SLOT_CONFLICT` sin reserva; la recuperación deja **1 sola reserva confirmada** y el portal la muestra |
| La sesión vence durante el journey | La sesión nueva reentrega la intención pendiente (1 sola intención) |
| Respuesta truncada con `tool_use` a medias | No se ejecuta; la transcripción queda válida (Fase 8B, se mantiene) |

## 5. Claude real de punta a punta desde la interfaz, y comparación

**UI con Claude** (`E2E_REAL_LLM=1 pnpm exec playwright test`, Sonnet 5.5, prompt v5, lenguaje natural sin sugerencias): **4/4 escenarios.**

| Escenario | Qué se verificó en pantalla | Duración ScriptedLlm | Duración Claude |
|---|---|---|---|
| **A** | Evaluación, cotización, horarios, reserva preparada, **sin confirmar hasta el clic**, folio; etiqueta «IA generativa: claude-sonnet-5-5» y «Respuesta generada por IA»; tabla de rendimiento en las trazas | 2,2 s | 21,4 s |
| **B** | Caso para un asesor, sin cotización; caso visible en la bandeja del asesor | 1,4 s | 9,0 s |
| **C** | Atención por seguridad, asistente detenido; «cotízame igual» sin cotización | 1,5 s | 5,0 s |
| **D** | Cupo tomado, conflicto, nuevos horarios, nueva reserva y **un solo** folio | 3,1 s | 25,8 s |

Capturas: `prd/reports/screenshots/desktop-real-*.png`.

**Métricas de esa corrida, leídas de la observabilidad nueva (12 turnos):**
- servidor: total medio 4,3 s (p50 4,0 s); IA 4,25 s; gateway 17 ms; BD y orquestación 27 ms;
- 85,7 % del prompt servido desde caché;
- **costo USD 0,11**;
- latencia percibida por turno en la UI: 3,8 a 7,8 s (`prd/reports/evidence/ui-e2e-real.json`).

**Re-evaluación de 41 casos con Sonnet** (comprueba que la guardia acotada no generó falsos positivos):

| Métrica | Fase 8B | Fase 8C |
|---|---|---|
| Casos aprobados | 41/41 | **41/41** |
| Bloqueos de la guardia / jerga interna | 0 / 0 | 0 / 0 |
| Precios o km inventados / reservas sin clic / afirmaciones falsas | 0 / 0 / 0 | 0 / 0 / 0 |
| Seguridad (verdaderos positivos / falsos negativos / falsos positivos) | 6 / 0 / 0 | 6 / 0 / 0 |
| Latencia p50 / p95 | 3,7 s / 6,7 s | 3,9 s / 6,4 s |
| Caché / costo | 88,4 % / USD 0,65 | 88,8 % / USD 0,64 |

Evidencia: `agent-eval-anthropic-claude-sonnet-5-5-run5-8c-prompt-v5.json`.

**Lectura:** con Claude, el journey funciona igual que con ScriptedLlm en resultados y controles. La diferencia es la latencia: unos 4 s por turno, casi todos de generación del modelo, frente a milisegundos. La UI ahora explica esa espera.

## 6. Pruebas y validación

| Comando | Resultado |
|---|---|
| `pnpm test` | **199/199** |
| `pnpm test:integration` | **190/190** (antes 179) |
| `pnpm test:journeys` | 13/13 |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | exit 0 |
| `pnpm test:coverage` (dominio) | 99,8 % |
| `pnpm db:verify-migrations` | 13 migraciones (2 nuevas, aditivas); sin drift |
| `pnpm test:e2e` (ScriptedLlm) | 25/25 |
| E2E `@real` | 4/4 (con autorización) |
| `pnpm test:evals` | 2 omitidas, sin autorización |

**Pruebas nuevas de integración:**
- `agent-reliability`: lease con fencing (2) y observabilidad (1);
- `failure-injection`: 5 casos;
- `guard-scope`: 3 casos.

## 7. Costos (estimados con tarifas de referencia; el monto exacto está en la consola)

| Concepto | Costo |
|---|---|
| UI real | USD 0,11 |
| Evaluación de 41 casos | USD 0,64 |
| **Total de la Fase 8C** | **≈ USD 0,75 de USD 2 autorizados** |
| Acumulado de las Fases 8A–8C | ≈ USD 6,7–6,9 |

## 8. Riesgos pendientes

| Riesgo | Mitigación sugerida |
|---|---|
| La guardia valida números, fechas y afirmaciones conocidas, no la atribución semántica (un km histórico real asignado al servicio equivocado pasa) | Mantener evaluaciones periódicas; considerar validación estructurada por tipo de dato en las tarjetas |
| Al reemitir el token, el botón de una pestaña antigua deja de servir | La UI ya pide horarios de nuevo; se podría avisar «tarjeta reemplazada» si se observa en el piloto |
| El limitador de tasa por IP sigue en memoria (el tope diario sí es global) | Almacén compartido en el despliegue |
| Una corrida real por fase, con casos sintéticos | Repetir antes de cada despliegue con presupuesto; incorporar conversaciones reales anonimizadas del piloto |
| La plantilla y el léxico de seguridad siguen provisionales (D6); la nota del PDF «no se ha validado un LLM real» está desactualizada | Aprobación técnica; actualizar el PDF con tu aprobación |
