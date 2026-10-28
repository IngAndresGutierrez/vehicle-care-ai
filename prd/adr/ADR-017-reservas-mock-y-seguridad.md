# ADR-017 — Reservas de extremo a extremo con sistemas MOCK

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-28 · **Afecta:** `src/integrations`, `src/application/booking`, `src/application/workshop`, ARCHITECTURE §4.3 y §7, AGENT_DESIGN §3.2 y §4.3

## Contexto
La Fase 4 implementa cotización, disponibilidad, intención y confirmación de reservas, y el ciclo de la orden de trabajo, contra sistemas MOCK persistentes. Además debe cumplir AC05, AC06 y AC09 y las excepciones EX-03, `QUOTE_EXPIRED`, `NO_SLOTS`, `WORKSHOP_UNAVAILABLE` y `SAFETY_ESCALATED`.

## Decisiones

**Integraciones**
1. **Puertos** `WorkshopPort` y `CrmPort` con resultados `{ ok, data | error, source }`. Nunca lanzan por errores de negocio y todo resultado declara `source: "MOCK"`.
2. **Taller simulado en dos piezas:**
   - `MockWorkshopSystem` imita la API de un proveedor (códigos propios en español, tablas `Mock*` y transacciones propias).
   - `MockWorkshopAdapter` es la capa anticorrupción (`RAW_ERROR_MAP`). Un código desconocido se trata como indisponibilidad, nunca como éxito.
3. El cupo se descuenta de forma atómica (`UPDATE … WHERE remaining > 0`) y la reserva del taller es idempotente por clave, con detección de contenido distinto (`IDEMPOTENCY_MISMATCH`). El taller valida la vigencia de su propia cotización (`MockQuote`).
4. **Inyección de fallos persistente** (`MockScenario`): `WORKSHOP_DOWN`, `QUOTE_UNAVAILABLE`, `SLOT_CONFLICT_ON_NEXT_BOOKING`, `BOOKING_TIMEOUT_AFTER_COMMIT`, `BOOKING_TIMEOUT_BEFORE_COMMIT` y `CRM_DOWN`.
5. **Catálogo MOCK sintético** (`SYNTHETIC-DEMO:catalogo-mock-v1`), con restricción explícita «Precio sintético de demostración: no es una tarifa real». V4 (motor no identificado) no tiene precio a propósito.
6. **CRM:** las interacciones se registran después del commit y como mejor esfuerzo. Una caída del CRM no revierte una reserva confirmada.

**Seguridad de reservas**

7. **Token de confirmación:** 256 bits aleatorios (base64url), entregado una sola vez por `prepareBooking`. Solo se persiste su sha256: la migración renombra la columna y convierte los valores existentes sin `DROP`. Nunca aparece en logs, `AuditLog`, eventos, reservas ni en el CRM (verificado por test).
8. **La intención liga** token, solicitante, titular (`customerId`), vehículo, cotización, servicio, taller y cupo. Expira a los 10 minutos o al vencer la cotización, lo que ocurra primero (resuelve D-23). Repetir la preparación con la misma clave **reemite** el token e invalida el anterior.
9. **Confirmación solo humana:** el propietario titular para el que se emitió la intención, o un asesor con acceso por cartera o caso. `SYSTEM_AGENT`/`SYSTEM_JOB` reciben `AGENT_CANNOT_CONFIRM`. La BD exige `confirmedByRole ∈ {OWNER, ADVISOR}` en toda reserva `PENDING`/`CONFIRMED`.
10. **Confirmación en tres fases:**
    - **A (transacción):** revalida token, actor, titularidad, journey (no `SAFETY_ESCALATED`, intención pendiente correcta), vigencia de intención y cotización, y que no haya reserva activa. Crea `Booking PENDING` con clave `vc-booking:{intentId}` y marca la intención `CONSUMED`.
    - **B:** solicitud al taller fuera de transacción.
    - **C (transacción):** `CONFIRMED` con folio + `BOOKING_CONFIRMED`, o `FAILED` + `BOOKING_FAILED`.
    
    Los clics duplicados o concurrentes devuelven la misma reserva.
11. **Resultado incierto** (timeout del taller, `OUTCOME_UNCERTAIN`): la reserva queda `PENDING` sin folio y el journey en `AWAITING_CONFIRMATION`. Repetir el clic no vuelve a llamar al taller. `reconcileBooking` (sistema o asesor autorizado) consulta por la clave: si la encuentra, confirma (el evento conserva al humano que confirmó); si no existe, la da por fallida; si el taller sigue caído, reintenta y escala a un humano (`BOOKING_FAILURE`, HIGH) tras 3 intentos (D-36) **sin mover el journey**.
12. **Compensación:** si el journey cambia mientras el taller procesa (p. ej. `SAFETY_SIGNAL`), la reserva creada en el taller se cancela allí y queda `CANCELLED`. Nunca llega a `BOOKED`. Si la cancelación falla, queda `PENDING` con un caso `DATA_CONFLICT`.
13. **«Confirmada» solo con folio:** `describeBooking` nunca presenta una reserva `CONFIRMED` sin folio emitido por el taller.

**FSM (ajuste mínimo)**

14. Nueva regla `QUOTE_ISSUED` desde `SLOT_SELECTION` → `QUOTE_PRESENTED` (recotización si la cotización caduca antes de preparar), y `getQuote` añadida a `allowedTools(SLOT_SELECTION)`. Sin cambios en las guardias existentes.
15. **Hechos de sistema** (caducidad de la intención, re-evaluación tras el servicio) se registran con actores explícitos de sistema (`system:booking-service`, `system:post-service-evaluation`, rol `SYSTEM_JOB`). Los eventos de decisión (`BOOKING_CONFIRMED`, `BOOKING_FAILED` en la confirmación) conservan al humano.

**Taller**

16. `openWorkOrder`/`completeWorkOrder`: solo `WORKSHOP_COORDINATOR`/`TECHNICIAN` del taller de la reserva.
    - El cierre registra servicio y odómetro `WORKSHOP_VERIFIED` con origen `SYNTHETIC` (el taller es MOCK; D-09) y rechaza retrocesos de odómetro.
    - Es idempotente con los mismos datos.
    - Tras el commit re-evalúa el plan (`REEVALUATED` → `FOLLOW_UP`).
17. `recordOdometer` serializa por vehículo (`SELECT … FOR UPDATE`). Rechaza retrocesos frente a la última lectura verificada y deriva la procedencia del rol (propietario/asesor → `OWNER_DECLARED`; taller → `WORKSHOP_VERIFIED`).

**Trazabilidad**

18. `AuditLog` en cada mutación (cotización, intención, solicitud, confirmación, fallo, resultado incierto, reconciliación, compensación, órdenes, odómetro y casos), sin tokens ni texto libre. **No se crean `ToolCall`:** corresponden a llamadas reales del agente a través del gateway (Fase 5).

## Consecuencias y límites
- **Reconciliación:** «no encontrada» = no procesada es válido porque el MOCK es síncrono. Con un taller real hará falta una ventana de gracia o un webhook antes de dar una reserva por fallida (D-37).
- **Expiración:** las intenciones vencidas se expiran al intentar confirmarlas. No hay un job de expiración proactiva (P1).
- **Disparo de la reconciliación:** no hay un job que reconcilie periódicamente las reservas `PENDING`; hoy se invoca bajo demanda (Fase 5/6).
- **Cancelación:** fuera del MVP por parte del cliente; la compensación usa la cancelación del taller.
