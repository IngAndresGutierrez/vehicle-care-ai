# ADR-022 — Calidad conversacional, guardia tipada y fiabilidad de turnos

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-29 · **Afecta:** `src/agent/**`, `src/infra/container.ts`, `prisma/` (una columna nueva), `tests/**`, `scripts/eval-agent.ts`

## Contexto
La evaluación real de la Fase 8A (ADR-021) dejó:
- falsos positivos documentados de la guardia;
- respuestas con jerga interna («el sistema no me habilita…»);
- huecos de fiabilidad.

Cada cambio de esta ADR responde a un fallo observado (textos reales en `src/agent/__tests__/fixtures/guard-false-positives-8a.json`) o a una prueba que falló antes de corregirlo. **No se modificó `src/domain`** (Maintenance Engine, FSM, políticas) **ni `src/application`**.

## Decisiones

**Configuración**
1. **Modelo por defecto `claude-sonnet-5-5`** (`DEFAULT_LLM_MODEL`); Opus sigue configurable con `LLM_MODEL`. `LLM_PROVIDER` sigue siendo `scripted` por defecto.
2. **Ninguna prueba general puede activar el proveedor real:**
   - en Vitest, `buildLlm` rechaza `anthropic` sin `RUN_LIVE_LLM_EVALS=1`;
   - Playwright verifica en su `globalSetup` que el servidor usa un LLM simulado (o exige `E2E_ALLOW_REAL_LLM=1`);
   - `eval:agent` sigue exigiendo `EVAL_BUDGET_USD`.

**Guardia de salida.** La regla no cambia: ninguna cifra ni afirmación sobre precio, intervalo, estado de reserva o folio sin respaldo estructurado.

3. **Hechos tipados.** Se leen de la base para el vehículo: lecturas de odómetro y su antigüedad, historial, reglas del plan VALIDADO, última evaluación, cotizaciones vigentes, intenciones y plazos de casos. Solo **añaden** respaldo verdadero; antes, una cifra correcta mencionada en un turno sin herramientas se bloqueaba.
4. **Análisis por oración** (sin romper «75.000» ni «8:00»):
   - «estás al día» negado por el hablante («no puedo decirte que…») no es afirmación;
   - una cifra escrita por el propietario puede citarse para **rechazarla o atribuirla** («no puedo confirmarte los $99.000»), nunca con un verbo de precio («cuesta $99.000, como te dijo el asesor» sigue bloqueado).
5. **Equivalencias y fechas:**
   - «75 000», «75 mil» y «75k» se validan como 75000;
   - las **fechas en lenguaje natural** («1 de abril de 2027», «jueves 29 de octubre») se validan contra los mismos hechos que las ISO. Antes no se validaban.
6. **Diagnóstico** = atribuir una falla a una pieza («el problema es la bomba», «seguramente es el alternador»). «El problema es que no hay historial» es una explicación.
7. **Motivo de bloqueo registrado:** `GUARD:<motivo>` en los mensajes, visible en el panel de trazas. El evaluador cuenta los bloqueos por motivo.

**Fiabilidad**

8. **Lease de turno por sesión** (columna `turnLockedUntil`, migración aditiva). Un segundo mensaje simultáneo recibe `TURN_IN_PROGRESS` **antes** de ejecutar herramientas; antes, ambos ejecutaban herramientas y uno fallaba al guardar. `CONCURRENT_TURN` queda como respaldo.
9. **Sesiones inactivas.** Si una sesión pasa más de 2 horas inactiva (`sessionIdleMs`), se renueva.
10. **Respuesta truncada** (`max_tokens`) con `tool_use` a medio escribir: no se ejecuta y recibe un `tool_result` de error. Antes, la transcripción quedaba inválida y la API habría rechazado los turnos siguientes. Además, la transcripción nunca termina en un turno del usuario sin respuesta.
11. **Fallo del proveedor después de herramientas.** Se aplica el mismo evento `RECOMMENDATION_SHOWN` que en el camino normal, porque la tarjeta llega al propietario; sin él, el siguiente turno no podía cotizar. Los códigos de error se persisten (`ERROR:<código>`).

**Conversación y contexto**

12. **Prompt v5:**
    - no mencionar estados, herramientas ni permisos;
    - si piden precio u horarios primero, evaluar y ofrecer el siguiente paso;
    - un «sí/dale/listo» basta para continuar;
    - retomar tras interrupciones o errores.
    
    Las transiciones de la FSM no cambian.
13. **Contexto por turno compacto.** Representaba el 43 % de la transcripción (medido). Ahora lleva solo identificadores y el orden de los horarios; el detalle ya está en los resultados de herramientas. La memoria completa sigue guardada para la guardia. No se introdujo ninguna técnica nueva de memoria ni de compresión.

## Consecuencias
- **Medido con Sonnet 5.5, sobre los mismos 36 casos que la Fase 8A:**
  - casos aprobados: 35 → 36;
  - bloqueos de la guardia: 4 → 0;
  - jerga interna: 1 → 0;
  - latencia p50: 4,5 s → 3,9 s;
  - costo por turno: −15 %.
  
  Con los 5 casos nuevos de conversación, el resultado es 41/41.
- Queda un punto ciego conocido: la guardia valida cifras y fechas, pero no el sentido completo de frases libres.
