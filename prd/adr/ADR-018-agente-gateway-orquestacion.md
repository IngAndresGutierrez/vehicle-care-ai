# ADR-018 — MaintenanceAdvisor: LlmPort, Tool Gateway y orquestación

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-28 · **Afecta:** `src/agent/**`, `src/infra/{container,session,rate-limit,http}`, `src/app/api/**`, AGENT_DESIGN §2–§7

## Contexto
La Fase 5 conecta un agente conversacional con los casos de uso existentes sin cederle decisiones técnicas ni comerciales. Restricciones: sin API real obligatoria (demo reproducible), ningún dato inventado en pantalla y trazabilidad por turno.

## Decisiones

**Modelo y proveedor**
1. `LlmPort` neutral, con dos implementaciones:
   - `AnthropicLlm`: SDK oficial `@anthropic-ai/sdk` 1.3.0 y Messages API con bucle manual.
   - `ScriptedLlm`: reglas deterministas, rotulado **«simulación determinista, no es IA generativa»** en la API, las trazas y la evidencia.
   
   `SequenceLlm` simula en tests un modelo arbitrario, incluso uno manipulado.
2. **Configuración por entorno** (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_EFFORT`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_SERVER_FALLBACKS`). Por defecto `scripted`; con `anthropic`, el modelo por defecto es **`claude-opus-5-5`** con esfuerzo `medium` (resuelve D-18).
   - No se envía `temperature` (la API la rechazará) ni `thinking` (pensamiento adaptativo por defecto). `tool_choice` es `auto`, porque el modo forzado no está disponible en este modelo.
   - **Fallback de rechazo del lado del servidor activado por defecto** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); se desactiva con `LLM_SERVER_FALLBACKS=false`.
3. **Prefijo estable** (*preserved thinking*): en Opus 5.5, editar el historial o cambiar `system`/`tools` dentro de una conversación invalida los bloques de pensamiento posteriores. Por eso:
   - el system prompt `advisor-v1` es estático;
   - **el catálogo completo de herramientas se declara siempre**, en orden fijo;
   - el contexto variable (estado, herramientas permitidas, memoria) llega en un **mensaje `role: "system"` añadido tras cada mensaje del usuario**;
   - la transcripción se guarda **solo con añadidos**: trigger de BD que exige que la versión anterior sea prefijo exacto, más bloqueo optimista por `turnCount`;
   - los bloques de pensamiento se conservan opacos y se reenvían intactos.
   
   Desviación de AGENT_DESIGN §2: el LLM ve todas las herramientas, pero **el gateway rechaza las no permitidas en el estado** (`TOOL_NOT_ALLOWED_IN_STATE`).
4. **Límites por turno:**
   - 6 iteraciones, 8 llamadas a herramientas, 4.096 tokens de salida por llamada y 16.000 por turno;
   - timeout de 45 s con `AbortController`;
   - mensajes de hasta 2.000 caracteres y 40 turnos por sesión.
   
   Al cortar, todo `tool_use` recibe su `tool_result`, de modo que la transcripción sigue siendo válida.

**Tool Gateway**

5. Diez herramientas con esquemas Zod `.strict()`, todas con campos obligatorios y **sin parámetros de identidad, vehículo ni traza**: los inyecta el servidor desde la sesión.
   - No existen herramientas para confirmar reservas, cerrar órdenes, aplicar descuentos ni modificar planes.
   - Al modelo se le envían con `strict: true` y sin palabras clave de rango; Zod las impone en el gateway.
6. **Orden del gateway:** límite de llamadas → catálogo (`UNKNOWN_TOOL`) → esquema (`INVALID_INPUT`) → estado (`allowedTools`) → **consentimiento `AI_ASSISTANT_PROCESSING`** → idempotencia (sha256 de traza + herramienta + entrada) → caso de uso (que vuelve a autorizar por titularidad) → `ToolCall` (vehículo pseudonimizado con HMAC, entrada redactada y resumen) → proyección al modelo sin PII.
7. **El token de confirmación de `prepareBooking` nunca llega al modelo**, ni a la transcripción, `ToolCall` o `ConversationMessage`. Solo viaja en la tarjeta `BOOKING_INTENT` de la respuesta HTTP en vivo al propietario autenticado.
8. `createHumanCase` con `SAFETY_ESCALATION` se ejecuta como `reportSafetySignal` (URGENT y `SAFETY_ESCALATED`) y corta el turno con la plantilla aprobada. La prioridad `URGENT` fuera de seguridad se rechaza.
9. En conversación, cada `evaluateMaintenance` registra `EVALUATED`, de forma idempotente por evaluación (a diferencia del job, que omite las redundantes). `RECOMMENDATION_SHOWN` se aplica cuando la **tarjeta** de evaluación accionable llega al propietario.

**Guardrails**

10. **Preclasificador de seguridad** (`safety-lexicon-v1`, sensible por diseño) **antes del LLM**: crea el caso URGENT sin llamar al modelo y responde con una plantilla provisional rotulada (D-24, D-25). Si el journey ya está escalado, no duplica el caso.
11. **Detector de inyección:** heurístico y **solo marca** (`INJECTION_SUSPECT`, `THIRD_PARTY_DATA_REQUEST`, `TOOL_ESCALATION_REQUEST`). La defensa real son los controles en código.
12. **Validador de salida:** importes, kilometrajes, periodos, fechas y folios deben existir en los resultados estructurados de herramientas o en la memoria vigente, o haber sido escritos por el propietario en su último mensaje.
    - Bloquea afirmaciones de reserva sin folio, «está al día» con `UNKNOWN`, certificaciones y diagnósticos.
    - Si algo falla, devuelve **texto de respaldo determinista sin regeneración** (resuelve D-27 con 0 reintentos) y marca `OUTPUT_BLOCKED`. En el turno siguiente el modelo sabe que su respuesta fue bloqueada.
13. **Tarjetas** (`EVALUATION`, `PLAN`, `WORKSHOPS`, `QUOTE`, `SLOTS`, `BOOKING_INTENT`, `HUMAN_CASE`, `SAFETY`, `ODOMETER_RECORDED`) construidas solo desde resultados estructurados.
14. **Memoria estructurada** por sesión y vehículo con caducidad (30 min; la cotización y los cupos caducan con su propia vigencia). No es fuente técnica.

**API**

15. `POST /api/agent/turn`:
    - sesión firmada (HMAC, `SESSION_SECRET` de 32 o más caracteres; resuelve D-11 sin dependencias);
    - solo `OWNER`;
    - cuerpo estricto de hasta 8 KB;
    - límite de tasa en memoria (20 turnos/min/actor);
    - respuesta con texto, tarjetas, journey, traza segura y errores recuperables.
16. `POST /api/bookings/confirm` (clic humano, 10/min) y `POST /api/demo/session`, este último solo con `DEMO_MODE=true` y rotulado «Sesión simulada».
17. **FSM:** `OWNER_OPENED` también desde `ACTIVATED`, para poder conversar sobre servicios sin necesidad detectada, como la correa de V2 en EX-01.

## Consecuencias
- La demo funciona sin API key y es reproducible (`pnpm demo:agent-journeys`). Con un modelo real los textos variarán, pero los controles son los mismos.
- **El adaptador real solo se verificó con un transporte simulado** que inspecciona la solicitud HTTP. No se llamó a la API de Anthropic en esta fase.
- **Limitador en memoria:** no sirve con varias instancias (P1: almacén compartido).
- **Turnos concurrentes:** en la misma sesión, el perdedor recibe 409, pero puede haber ejecutado herramientas idempotentes antes (P1: reclamar el turno al inicio).
