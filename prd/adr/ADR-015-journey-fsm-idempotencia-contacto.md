# ADR-015 — Journey: FSM persistente, idempotencia y política de contacto

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-28 · **Afecta:** `src/domain/journey`, `src/domain/contact`, `src/application/journey`, recordatorios, ARCHITECTURE §6

## Contexto
La Fase 3 exige una FSM determinista y auditable. Además, la Fase 2 dejó tres hallazgos P0:
1. Re-ejecutar el job duplicaba evaluaciones **y recordatorios**.
2. Asesor y compliance accedían a cualquier vehículo (ver ADR-016).
3. IT-05 no aplicaba la transición `CONTACT_SUPPRESSED` del journey.

## Decisiones

**FSM (dominio puro)**
1. Tabla declarativa `RULES` (evento, estados de origen, condición, destino, guardia, actualización de contexto, efectos). Gana la primera regla que coincide. Sin dependencias (resuelve D-07).
2. Errores tipados: `TERMINAL_STATE`, `ACTOR_NOT_PERMITTED`, `INVALID_TRANSITION`, `GUARD_REJECTED`. Nunca hay no-op silencioso; las auto-transiciones (`SAME`) quedan registradas como eventos.
3. `EVENT_ACTORS` define qué roles emiten cada evento. El agente nunca confirma reservas, resuelve casos ni completa órdenes; el job nunca resuelve casos.
4. El `JourneyContext` (última evaluación, cotización activa, intención pendiente, reserva activa, caso abierto) lo calcula la FSM y se persiste con el estado. Las guardias dependen de él (intención correcta, sin reserva activa, caso correcto…).
5. Los eventos son **hechos de negocio con identificadores**: el texto de usuario y de casos nunca entra en `JourneyEvent`. La BD lo garantiza con un CHECK sobre el catálogo de tipos, que un test unitario mantiene sincronizado con `JOURNEY_EVENT_TYPES`.
6. Seguridad: `SAFETY_SIGNAL` desde cualquier estado activo. Invalida la intención de reserva pendiente (efecto `INVALIDATE_BOOKING_INTENT`, aplicado en la misma transacción). La salida solo es posible con `CASE_RESOLVED_BY_HUMAN` (ADVISOR/COMPLIANCE) del caso abierto. `HUMAN_CASE_OPENED` con motivo de seguridad se rechaza: debe usarse la señal.
7. Reconciliación con AGENT_DESIGN: `createHumanCase` (handoff) se permite en todos los estados activos salvo `SAFETY_ESCALATED`, incluido `AWAITING_CONFIRMATION`, donde abrir un caso invalida la intención. `SAFETY_ESCALATED` solo admite lectura de perfil e historial.
8. Desviaciones respecto a §6.2: `PLAN_MISSING` y `QUOTE_UNAVAILABLE` no son eventos propios, sino `EVALUATED` con motivo de plan y `HUMAN_CASE_OPENED(reason=QUOTE_UNAVAILABLE)`. `EVALUATED(UNKNOWN)` mantiene el estado hasta que se abra un caso. `CONTACT_SENT` desde `CONTACT_SUPPRESSED` vuelve a `NEED_DETECTED` (consentimiento re-otorgado).

**Persistencia y concurrencia**

9. Cada evento se aplica en una transacción: idempotencia → FSM → `UPDATE … WHERE version = n` (bloqueo optimista) → `JourneyEvent(seq = n+1)` → efectos.
10. `JourneyEvent.idempotencyKey` es único: un reintento devuelve `DUPLICATE`, y la misma clave para otra operación devuelve `IDEMPOTENCY_MISMATCH`.
11. Con `expectedVersion` (acciones de usuario), un conflicto devuelve `VERSION_CONFLICT` sin reintentar. Sin ella (sistema), se reintenta con backoff (8 intentos).
12. `verifyJourneyConsistency` reproduce los eventos con la FSM y compara estado y versión.
13. El job solo aplica `EVALUATED` en `ACTIVATED`, `MONITORING`, `NEED_DETECTED`, `CONTACT_SUPPRESSED` y `PLAN_PENDING_VERIFICATION`, y omite las re-evaluaciones redundantes (mismo estado, resultado y ciclo). Nunca altera una conversación, reserva o escalamiento en curso.

**Recordatorios**

14. Clave de deduplicación `reminder:v1:{vehículo}:{servicio}:{regla}:{servicio de referencia}:{versión de política}:{inicio de ventana}:{SENT|SUPPRESSED}`. **No usa `inputHash`**. El ciclo solo cambia cuando hay un nuevo servicio de referencia o una nueva regla. La ventana es un bloque fijo de `minDaysBetweenReminders` días.
15. `CommunicationPolicy.minDaysBetweenReminders` (14) y `maxRemindersPerCycle` (2) son configurables (valores provisionales, D-31). Orden de la decisión: necesidad → estado del journey → consentimiento → tope → separación mínima.
16. Sin consentimiento: `SUPPRESSED` (`CONSENT_REQUIRED`), una vez por ventana, sin `consentEventId` y **sin invocar el puerto**. Tope alcanzado: `SUPPRESSED` (`FREQUENCY_CAP`).
17. **Outbox simplificado:** el mensaje y su evento `CONTACT_*` se registran en la transacción y el puerto (`MockNotificationPort`, que nunca envía) se invoca después del commit, solo para mensajes nuevos.

## Consecuencias
- Re-ejecutar o ejecutar en paralelo el job no duplica mensajes, notificaciones ni eventos. Sí añade una evaluación por ejecución, lo cual es intencional para auditoría.
- Si el proceso cae entre el commit y la entrega, el mensaje queda registrado sin entregar. Con un proveedor real hará falta un worker de outbox con reintentos (Fase 4/P1).
- `CLOSED` es terminal y el journey es único por vehículo y servicio: reabrir un ciclo tras un cierre manual requiere una decisión de diseño (P1).
- Las columnas obligatorias nuevas usan `CHECK … NOT VALID`; validar con `VALIDATE CONSTRAINT` tras revisar los datos existentes.
