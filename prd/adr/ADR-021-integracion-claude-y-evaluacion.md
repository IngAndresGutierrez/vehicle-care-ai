# ADR-021 — Integración real con Claude: caché, resiliencia, guardia y prompt v4

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-29 · **Afecta:** `src/agent/**`, `src/infra/container.ts`, `scripts/eval-agent.ts`, `tests/evals/**`

## Contexto
La Fase 8A ejecutó por primera vez el agente contra la API de Anthropic, con `claude-sonnet-5-5` y `claude-opus-5-5`, sobre 36 casos. Los problemas observados vinieron casi todos de **nuestros controles**, no de los modelos. Ningún cambio de esta ADR agrega acciones autónomas, modifica el Maintenance Engine ni debilita un control.

## Decisiones
1. **Prompt caching.** El adaptador marca un punto de caché explícito al final del prefijo estable (herramientas + system) y activa la caché automática para la cola de la conversación (`cache_control` en la solicitud). Se desactiva con `LLM_PROMPT_CACHE=false`. Se contabilizan `cache_read_input_tokens` y `cache_creation_input_tokens`. Resultado medido: el 86–87 % del prompt se sirvió desde la caché.
2. **Fallo del proveedor después de ejecutar herramientas.** Antes, el turno se descartaba aunque `prepareBooking` ya hubiera creado la intención y el journey hubiera avanzado: el propietario no recibía la tarjeta. Ahora se entregan las tarjetas (construidas desde los resultados de las herramientas) y la memoria, con un texto fijo sin cifras y la marca `LLM_FAILED_AFTER_TOOLS`. Nada se duplica ni se confirma. Los reintentos del SDK solo repiten **llamadas al modelo**, nunca acciones de negocio: el SDK respeta `retry-after` y `retry-after-ms`, y una solicitud inválida (400) no se reintenta.
3. **Sesiones y pensamiento preservado.** Si la sesión se creó con otra versión del prompt, o con otro modelo real, se abre una sesión nueva en lugar de reenviar bloques de pensamiento ligados a otro prefijo o modelo.
4. **Guardia de salida: tres falsos positivos corregidos con evidencia.** La regla «toda cifra o afirmación de reserva debe estar respaldada» no cambia:
   - acepta las cifras de **todas** las herramientas del turno (antes, solo la última cotización o agenda);
   - una mención de reserva o folio **negada, condicionada u ofrecida** no es una afirmación; se evalúa por oración y se reconocen las condiciones posteriores al verbo («solo queda reservada **cuando**…»);
   - un folio solo cuenta si se presenta como dato existente («tu folio es…» o un código `FOLIO-…`).
   
   Con Opus, los bloqueos bajaron de 19 a 3 por corrida; con Sonnet, de 6 a 4. Las afirmaciones reales («ya está confirmada», «te agendé») siguen bloqueadas, con pruebas.
5. **Léxico de seguridad v1.1.** Corrige el recall por orden de palabras e inflexión **dentro de las categorías existentes**: «se fue al rojo», «huele a quemado», «se me estalló una llanta». No agrega categorías. La plantilla sigue siendo provisional (D6).
6. **Fechas en hora de Colombia para el modelo.** Junto a cada fecha-hora que devuelven las herramientas se agrega `<campo>Local`, con fecha y hora de Colombia formateadas. Se conserva el valor ISO, porque identifica el cupo y lo usa la guardia. Antes, Opus mostraba horas UTC al propietario.
7. **Prompt v2 → v4**, por problemas observados:
   - **v2:** un taller a la vez (el sistema mantiene una sola cotización vigente); preparar la reserva cuando el propietario elige un horario; no repetir todas las cifras de las tarjetas.
   - **v3:** usar los campos `…Local`.
   - **v4:** con historial insuficiente, abrir siempre un caso humano (PRD AC07); Sonnet a veces solo lo explicaba.
8. **Evaluaciones en vivo con doble llave.** `pnpm test:evals` exige `ANTHROPIC_API_KEY` **y** `RUN_LIVE_LLM_EVALS=1`. `pnpm eval:agent` exige `EVAL_LLM=anthropic` y `EVAL_BUDGET_USD`, y se detiene al alcanzar el presupuesto. Motivo: una validación general consumió créditos al detectar la key en `.env`.
9. **Modelo recomendado: `claude-sonnet-5-5`, effort `medium`.**
   - Con los cambios de esta ADR, los dos modelos tuvieron los mismos resultados de seguridad: 0 cifras inventadas, 0 reservas sin clic, 0 afirmaciones falsas y 6/6 casos de seguridad.
   - Sonnet costó **≈ 2,1× menos** y tuvo **≈ 35 % menos latencia** (p50 4,5 s frente a 7,0 s).
   - Su brecha en AC07 se cerró con el prompt v4.
   - Opus sigue disponible por configuración (`LLM_MODEL`).

## Consecuencias
- `LLM_MODEL` por defecto: `claude-opus-5-5` en el código. **Para el piloto se recomienda fijar `LLM_MODEL=claude-sonnet-5-5`.** No se cambió el valor por defecto del código sin aprobación.
- La demo sigue con ScriptedLlm (D1).
- La guardia ya no valida fechas escritas en palabras (por ejemplo «jueves 29 de octubre»). Esas fechas vienen de los campos `…Local`.
