# ADR-023 — Robustez operativa: lease con fencing, reentrega de reservas, hechos acotados y observabilidad

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-29 · **Afecta:** `src/agent/**`, `src/application/booking/prepare-booking.ts` (función nueva sin cambio de reglas), `src/application/views/read-models.ts`, `prisma/` (2 columnas nullable), `src/ui/**`, `tests/**`

## Contexto
La auditoría de la Fase 8C encontró riesgos reales (prioridad en `REPORT_FASE_8C.md` §1):
- el lease de la Fase 8B no tenía fencing y dependía del reloj de cada instancia;
- una respuesta perdida tras `prepareBooking` dejaba al propietario sin token;
- la guardia mezclaba intervalos de otros servicios;
- el portal podía mostrar una reserva fallida en lugar de la confirmada;
- no había métricas por fase.

El Maintenance Engine, la FSM y las políticas (`src/domain`) no cambian.

## Decisiones
1. **`TurnLease` con fencing token y hora de la base.** `turnLeaseId` es único por turno y la comparación usa `now()` de PostgreSQL.
   - **Toma:** solo si no hay lease o si el anterior venció.
   - **Renovación:** antes de cada llamada al LLM y de cada herramienta, solo por el mismo token. Si otro turno tomó la sesión, este se detiene con `LEASE_LOST` **sin ejecutar más herramientas**.
   - **Escritura del turno:** exige el token y el `turnCount` (sin escrituras fuera de orden) y libera el lease en la misma operación.
   - **Liberación:** solo por el dueño.
2. **Reentrega de la reserva preparada.** Si el journey está en `AWAITING_CONFIRMATION` con una intención que la sesión actual nunca entregó (caída, respuesta perdida o sesión renovada), el servidor llama a `reissuePendingIntent`. Esta función usa el mismo `reissueToken` que el reintento idempotente: la **misma** intención, un token nuevo, y el anterior deja de servir. La tarjeta se vuelve a mostrar y el modelo recibe el aviso en el contexto. No hay transición nueva ni intención nueva.
3. **Hechos de la guardia acotados por:**
   - vehículo autorizado: el plan se lee con `getMaintenancePlan` y la identidad del titular (VALIDATED y vigente);
   - **servicio** de la conversación (intervalos);
   - lecturas de odómetro no `REJECTED` ni reemplazadas, y registros de servicio no reemplazados;
   - cotizaciones `ACTIVE` vigentes, más la de la reserva activa del journey;
   - intenciones del mismo servicio y titular.
4. **Portal:** «Tu cita» muestra la reserva activa del journey; si no la hay, una vigente antes que una fallida.
5. **Observabilidad por turno:**
   - `trace.timings`: total, IA, gateway, herramientas y BD/orquestación;
   - tokens, proporción de caché y costo estimado (`src/agent/llm/pricing.ts`);
   - todo se persiste en `ConversationMessage.metrics`, **sin texto ni datos personales**;
   - una tabla en el panel de trazas.
6. **UI con IA real:**
   - etiqueta «Respuesta generada por IA (modelo)» en cada mensaje;
   - espera progresiva (6 s y 20 s) que pide no reenviar;
   - reintento ofrecido solo si el proveedor falló **antes** de ejecutar herramientas;
   - mensaje propio para `LEASE_LOST`.
7. **E2E con Claude real desde la UI** (`tests/e2e/real-llm.spec.ts`, `@real`):
   - solo con `E2E_REAL_LLM=1`; la suite normal lo excluye en escritorio y en móvil;
   - en modo real, `globalSetup` exige un servidor que use de verdad Claude, y en modo normal uno simulado.

## Consecuencias
- **Escrituras:** cada paso del turno agrega un `UPDATE` de renovación. Costo medido: la porción de BD y orquestación promedió 27 ms por turno con Claude.
- **Reemisión implícita del token:** si el propietario tiene abierta una pestaña antigua con la tarjeta previa, ese botón deja de servir y la interfaz le pide los horarios de nuevo. Es preferible a dejarlo sin poder confirmar.
- **Limitación de la guardia:** los kilometrajes históricos del vehículo (de cualquier servicio) siguen siendo hechos válidos, así que la guardia no detecta atribuir un kilometraje real al servicio equivocado.
