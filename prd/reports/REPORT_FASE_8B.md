# Informe — Fase 8B (calidad conversacional y fiabilidad del agente)

**Fecha:** 2026-10-29 · **Alcance:** mejoras de calidad y fiabilidad basadas en fallos observados. Sin funcionalidades de negocio ni agentes nuevos. **Maintenance Engine, FSM y políticas de acceso intactos:** `git diff 460cce1 -- src/domain src/application` está vacío. Decisiones en ADR-022.

## 1. Resultados por fuente (separados)

| Fuente | Qué es | Resultado |
|---|---|---|
| **ScriptedLlm** (simulación, sin costo) | Regresión determinista de los controles | 38/41. Los 3 fallos son límites de palabras clave de la simulación («sí, dale», «el segundo horario»), no del agente |
| **Real anterior** (Fase 8A, Sonnet 5.5, prompt v3) | 36 casos, 73 turnos | 35/36; 4 bloqueos de la guardia; 1 respuesta con jerga interna |
| **Real anterior, verificación parcial** (Fase 8A, prompt v4) | **Solo 4 casos** de historial, no una corrida completa | 4/4 |
| **Real nuevo** (Fase 8B, Sonnet 5.5, prompt v5) | **Corrida completa: 41 casos** (los 36 + 5 de conversación), 83 turnos | **41/41** |

### Antes y después (Sonnet 5.5, los mismos 36 casos)

| Métrica | Fase 8A (prompt v3) | Fase 8B (prompt v5) |
|---|---|---|
| Casos aprobados | 35/36 | **36/36** |
| Respuestas sustituidas por la guardia | 4 | **0** |
| Respuestas con jerga interna («el sistema no me habilita») | 1 | **0** |
| Precios o km inventados / reservas sin clic / afirmaciones falsas / fugas | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Seguridad (verdaderos positivos / falsos negativos / falsos positivos) | 6 / 0 / 0 | 6 / 0 / 0 |
| Escalamiento humano esperado | 2/3 | **3/3** |
| Latencia p50 / p95 | 4,5 s / 7,5 s | **3,9 s / 7,1 s** |
| Salida por turno (tokens, incluye pensamiento) | 337 | **284** |
| Costo por turno (tarifas de referencia) | USD 0,0093 | **USD 0,0079 (−15 %)** |

**Corrida completa 8B (41 casos):**
- prompt servido desde caché: 88,4 %;
- costo: **USD 0,65** (tope autorizado: USD 1,50);
- 118 llamadas a herramientas, todas correctas;
- 0 errores de MOCK, FSM, gateway o proveedor.

## 2. Falsos positivos de la guardia: antes y después

| Conjunto | Antes | Después |
|---|---|---|
| 8 textos reales bloqueados por error en la Fase 8A (fixture versionado) | 8/8 bloqueados | **0/8**: todos pasan (prueba parametrizada) |
| 6 textos reales de reserva condicionada o futura (diagnóstico de la Fase 8A) | 6/6 bloqueados | 0/6 (pruebas OG-03b) |
| 13 afirmaciones equivalentes **sin respaldo** (por ejemplo «estás al día», «te sale en $99.000», «76 mil km», «2 de abril de 2027», «el problema es la bomba») | — | **13/13 siguen bloqueadas** |
| Corrida real 8B | 4 bloqueos por corrida (8A) | **0** |

## 3. Cambios implementados y justificación

| Cambio | Fallo observado que lo justifica |
|---|---|
| Hechos tipados del vehículo leídos de la base | «Tu kilometraje (74200 km)» y «cada 100000 km o 72 meses» se bloqueaban en turnos sin herramientas |
| Negación y atribución por oración | «No puedo decirte que estás al día» y «No puedo confirmarte los $99.000» se bloqueaban |
| Equivalencias de km y fechas en lenguaje natural | «75000 km» sin separador; antes, las fechas en palabras no se validaban (hueco de control) |
| Diagnóstico acotado | «El problema es que tu historial no registra…» (Opus) |
| Motivo de bloqueo persistido | No se sabía por qué se bloqueaba una respuesta sin leer la base de evaluación |
| Lease de turno (`TURN_IN_PROGRESS`) | Prueba: dos turnos simultáneos ejecutaban herramientas en paralelo |
| Cierre del `tool_use` truncado | Prueba: la transcripción quedaba inválida (la API rechazaría el siguiente turno) |
| Recomendación presentada tras un fallo del proveedor | Prueba: después de un timeout posterior a evaluar, el siguiente turno no podía cotizar |
| Renovación de sesión por inactividad | Prueba: una sesión de horas atrás se reanudaba con contexto viejo |
| Errores persistidos (`ERROR:<código>`) | Prueba: un timeout no quedaba registrado en el mensaje |
| Contexto por turno compacto | Medición: el contexto del servidor era el 43 % de la transcripción |
| Prompt v5 | «El sistema aún no me habilita esa consulta» (Sonnet y Opus) al preguntar el precio primero |
| Modelo por defecto Sonnet y bloqueo del proveedor real en pruebas | ADR-021 e incidente de gasto no autorizado de la Fase 8A |

## 4. Nuevas pruebas de regresión

| Suite | Antes | Ahora |
|---|---|---|
| Unitarias | 189 | **199** |
| Integración | 174 | **179** |

- **Unitarias:**
  - corpus real de la guardia (8 casos parametrizados);
  - 13 contraejemplos bloqueados;
  - equivalencias de formato;
  - fechas en lenguaje natural;
  - casos de diagnóstico.
- **Integración** (`agent-reliability.integration.test.ts`):
  - timeout antes y después de herramientas (tarjetas persistidas sin token, transcripción válida, el siguiente turno cotiza);
  - turnos simultáneos (una sola intención y una sola llamada a herramienta);
  - sesión vencida;
  - `max_tokens` con `tool_use` truncado.
- **Evaluación:** 41 casos.
  - **Casos nuevos de conversación:** precio primero y luego «sí, dale»; días primero y luego «listo»; cambio de taller; aclaración; dato desconocido.
  - **Métricas nuevas:** jerga interna, bloqueos por motivo y tamaño del contexto.

## 5. Latencia, memoria/contexto y caché (medidos)

| Medida | Antes | Después |
|---|---|---|
| Transcripción promedio con ScriptedLlm | 4.835 caracteres | **4.090 (−15 %)** |
| Transcripción máxima con ScriptedLlm | 23.481 caracteres | **18.636 (−21 %)** |
| Peso del contexto del servidor (ScriptedLlm) | 43,5 % | 33,3 % |
| Peso del contexto del servidor (Claude 8B) | — | 22,5 % (el pensamiento es el 7,4 %) |
| Prompt servido desde caché (Claude) | 86,1 % | **88,4 %** |

La latencia está en §1. No se agregaron técnicas de compresión ni de memoria nuevas: con 41 casos, la transcripción más larga mide unos 21.600 caracteres, lejos de cualquier límite.

## 6. Costos reales (estimados con tarifas de referencia del SDK; el monto exacto está en la consola)

| Concepto | Costo |
|---|---|
| Fase 8B | **USD 0,65** de USD 1,50 autorizados |
| Acumulado de las Fases 8A + 8B | ≈ USD 5,9–6,1 (incluye ≈ USD 0,1–0,3 de la ejecución no autorizada de la Fase 8A) |

## 7. Validación (sin costo, con ScriptedLlm)

| Comando | Resultado |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | exit 0 |
| `pnpm test` | 199/199 |
| `pnpm test:integration` | 179/179 |
| `pnpm test:journeys` | 13/13 |
| `pnpm test:coverage` (dominio) | 99,8 % |
| `pnpm db:verify-migrations` | 11 migraciones; sin drift |
| `pnpm test:e2e` | 25/25 (con la verificación de LLM simulado) |
| `pnpm test:evals` | 2 omitidas, sin autorización explícita |

## 8. Riesgos pendientes

| Riesgo | Mitigación sugerida |
|---|---|
| La guardia valida cifras, fechas y afirmaciones conocidas, no el sentido completo del texto libre | Mantener la evaluación periódica; revisar los bloqueos por motivo en el panel de trazas |
| Opus no se reevaluó con el prompt v5 | Corrida de comparación si se considera usarlo (≈ USD 1,6) |
| Los resultados son sobre casos sintéticos y de una sola corrida | Repetir antes de cada despliegue con presupuesto aprobado; ampliar casos con conversaciones reales del piloto, anonimizadas |
| El lease asume un reloj del servidor coherente | En despliegues con varias instancias, todas usan la hora del sistema; vence solo tras un fallo (turno más 15 s) |
| La plantilla y el léxico de seguridad siguen provisionales (D6) | Aprobación técnica antes de operar con clientes |
| La nota del PDF «no se ha validado un LLM real» está desactualizada | Actualizarla, con tu aprobación |
