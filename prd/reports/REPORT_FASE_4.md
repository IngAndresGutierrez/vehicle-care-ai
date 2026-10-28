# Informe — Fase 4 (cotización, disponibilidad, intención y confirmación de reservas con sistemas MOCK)

**Fecha:** 2026-10-28 · **Alcance:** solo Fase 4. Sin LLM, sin UI, sin APIs reales, sin SOAT/seguros/RUNT. Taller, CRM y mensajería son **simulados (MOCK)**; todo resultado se rotula `source: "MOCK"` y los precios son sintéticos (`SYNTHETIC-DEMO:catalogo-mock-v1`).

## 1. Validación (comandos ejecutados sobre el código final)

| Comando | Resultado real |
|---|---|
| `pnpm lint` | exit 0, 0 errores y 0 warnings |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (unitarios, sin BD) | exit 0 — **10 archivos, 152 tests** (146 previos + 6 nuevos) |
| `pnpm test:integration` (`vehicle_care_test`) | exit 0 — **8 archivos, 127 tests** (86 previos + 41 nuevos) |
| `pnpm test:coverage` | `src/domain`: 99,79 % stmts · 97,36 % ramas · 100 % funciones · 100 % líneas |
| `pnpm build` | exit 0 |
| `pnpm db:verify-migrations` | 9 migraciones desde una base vacía → «No difference detected» → seed → base eliminada |

Estabilidad: la suite de reservas (incluye último cupo concurrente y doble clic en paralelo) se ejecutó 3 veces más sin fallos.

## 2. Evidencia del flujo

`pnpm demo:booking-flow` usa una base desechable, ejecuta los casos de uso reales y escribe `prd/reports/evidence/booking-flow.json` con el token redactado. Resultado obtenido:

```
0. Evaluación (job)          V1 aceite → UPCOMING
1. Recomendación             RECOMMENDATION_PRESENTED
2. Talleres                  Taller Norte (demo), Taller Sur (demo)
3. Cotización (MOCK)         280.000 + IVA 53.200 = 333.200 COP (sintético) → QUOTE_PRESENTED
4. Horarios (MOCK)           cupos de T1 → SLOT_SELECTION
5. Intención                 token de un solo uso, expira en 10 min → AWAITING_CONFIRMATION
5b. El agente intenta confirmar → AGENT_CANNOT_CONFIRM
6. Confirmación (propietario) CONFIRMED, folio FOLIO-T1-DEMO-xxxxxxxx emitido por el taller MOCK
7. Journey                   1 EVALUATED · 2 CONTACT_SENT · 3 OWNER_OPENED · 4 RECOMMENDATION_SHOWN ·
                             5 QUOTE_ISSUED · 6 SLOTS_LISTED · 7 BOOKING_INTENT_CREATED · 8 BOOKING_CONFIRMED (OWNER)
                             → BOOKED; verificación de consistencia OK
```

## 3. Archivos

**Integraciones:**
- Puertos: `ports/workshop.ts`, `ports/crm.ts`
- MOCK: `mock/mock-workshop-system.ts` (API simulada del proveedor), `mock/mock-workshop-adapter.ts` (capa anticorrupción), `mock/mock-crm-adapter.ts`, `mock/mock-scenarios.ts`

**Casos de uso:**
- `booking/quotes-and-slots.ts` (`listWorkshops`, `requestQuote`, `getAvailableSlots`)
- `booking/prepare-booking.ts`
- `booking/confirm-booking.ts` (`confirmBooking`, `reconcileBooking`, compensación)
- `booking/common.ts`
- `open-human-case.ts`, `record-odometer.ts`, `workshop/work-orders.ts` (`openWorkOrder`, `completeWorkOrder`)
- `errors.ts` ampliado

**Infra y seed:** `infra/tokens.ts`; seed con el catálogo MOCK (idempotente).

**Dominio:** regla de recotización `SLOT_SELECTION → QUOTE_PRESENTED` y `getQuote` en `allowedTools(SLOT_SELECTION)`. El Maintenance Engine no se modificó.

**Tests:**
- Integración: `booking.integration.test.ts` (29), `workshop-ops.integration.test.ts` (12), helper `booking-flow.ts`.
- Unitarios: `mock-workshop-adapter.test.ts` (mapeo de errores y tokens) y la recotización en `machine.test.ts`.
- Ajustados `invariants` y `safety-handoff`: aportan los campos que ahora exigen los nuevos invariantes.

**Scripts:** `scripts/demo-booking-flow.ts` (`pnpm demo:booking-flow`).

**Docs:** ADR-017; ARCHITECTURE (§6, §7, ADRs, D-36…D-38), AGENT_DESIGN §4.3, DATA_MODEL (§3 y §4), IMPLEMENTATION_PLAN, README.

## 4. Migración `20261028220000_phase4_booking_mocks`

Es segura sobre datos existentes:
- **Token:** `RENAME COLUMN` + `UPDATE` a sha256 del token existente, en lugar de DROP/ADD. Las intenciones pendientes siguen siendo válidas y no queda texto plano.
- **`Booking`:** columnas de confirmador humano y de reconciliación.
- **`MockBooking`:** estado y referencias.
- **Tablas nuevas:** `MockQuote` y `MockCrmInteraction`.
- **CHECKs:**
  - token con formato de hash;
  - alcance obligatorio de la intención (`NOT VALID`);
  - `CONSUMED` ⇒ `consumedAt`;
  - **toda reserva `PENDING`/`CONFIRMED` tiene confirmador humano `OWNER`/`ADVISOR`** (`NOT VALID`);
  - total = subtotal + impuesto en `MockQuote`;
  - estados válidos en `MockBooking` y `MockWorkOrder`.

El SQL de Prisma (DROP + ADD de la columna del token) se reemplazó a mano por el renombrado; se verificó sin drift.

## 5. Decisiones (ADR-017)

- **Puertos y ACL:** `MockWorkshopSystem` usa códigos propios del proveedor (`CUPO_NO_DISPONIBLE`, `TIEMPO_AGOTADO`…) que el adaptador traduce. Un código desconocido nunca se trata como éxito. El cupo se descuenta de forma atómica y la reserva es idempotente en el taller.
- **Seguridad:** token de 256 bits que solo se guarda hasheado. Intención ligada a actor, titular, vehículo, cotización, servicio, taller y cupo, con expiración de 10 minutos. Confirmación solo humana, validada por código y por la BD. Revalidación completa antes de llamar al taller y bloqueo en `SAFETY_ESCALATED`.
- **Tres fases:** `PENDING` → taller → `CONFIRMED`/`FAILED`. Un timeout deja la reserva `PENDING` sin repetir la llamada y se resuelve con `reconcileBooking`, que escala a un humano tras 3 intentos. Si el journey cambia durante la llamada, la reserva se compensa (se cancela en el taller).
- **Auditoría:** `AuditLog` en cada mutación, sin tokens ni texto libre. No se crean `ToolCall` porque el agente aún no existe.

## 6. Cobertura de los requisitos de prueba

| Requisito | Test(s) |
|---|---|
| IT-07 cotización MOCK | flujo completo (montos, `source=MOCK`, `catalogVersion` sintético) |
| IT-08 sin precio | `Quote UNAVAILABLE` sin montos + caso humano asignado + `QUOTE_PENDING_HUMAN` |
| IT-09 sin cupos | `NO_SLOTS` (código del proveedor `SIN_CUPOS`), el journey no avanza |
| IT-10 confirmación | folio del taller, cupo −1, `BOOKED`, CRM registrado una vez |
| IT-11 último cupo concurrente | 1 `CONFIRMED` + 1 `FAILED(SLOT_CONFLICT)`; 1 reserva en el taller; ambos journeys consistentes |
| IT-12 confirmación duplicada | 3 clics en paralelo + reintento → 1 reserva, 1 folio, 1 `BOOKING_CONFIRMED` |
| IT-13 misma clave, otro contenido | `IDEMPOTENCY_MISMATCH` (`CLAVE_REUTILIZADA`) |
| IT-14 cotización vencida | `QUOTE_EXPIRED`, sin reserva, recotización posible; también cuando el taller la rechaza de su lado |
| IT-15 retroceso de odómetro | `ODOMETER_ROLLBACK` sin registrar |
| IT-16 cierre de OT | servicio y odómetro `WORKSHOP_VERIFIED` (`SYNTHETIC`), re-evaluación `NOT_DUE` (`dueByKm` 79.300), `FOLLOW_UP` |
| Tokens expirados, reutilizados o de otro usuario | `INTENT_EXPIRED` (+ `INTENT_EXPIRED` en la FSM); reemisión que invalida el token anterior; `INVALID_TOKEN`; `UNAUTHORIZED` para otro cliente y para el titular anterior; el token no aparece en ninguna tabla |
| Caída del taller antes o después de crear | `BOOKING_TIMEOUT_BEFORE_COMMIT` → reconciliación → `FAILED`; `BOOKING_TIMEOUT_AFTER_COMMIT` → `PENDING` → reconciliación → `CONFIRMED`; `WORKSHOP_DOWN` → `FAILED` sin nada creado |
| Resultado incierto y reconciliación | sin reintento ciego al repetir el clic; escalamiento tras 3 intentos, sin mover el journey; solo sistema o asesor reconcilian |
| Confirmación tardía tras `SAFETY_SIGNAL` | bloqueada sin llamar al taller; señal **durante** la llamada → compensación (cancelada en el taller, nunca `BOOKED`) |
| Consistencia Booking ↔ taller ↔ JourneyEvent | folio, cupo, clave, intención y evento coinciden; `verifyJourneyConsistency` OK |
| Acceso a otros clientes | cotizar, cupos, talleres y preparar sobre un vehículo ajeno → `UNAUTHORIZED`; cotización de otro vehículo → `QUOTE_MISMATCH` |
| Cierre de OT por rol no autorizado | propietario, agente, asesor, compliance y job → `UNAUTHORIZED`; personal de otro taller → `OTHER_WORKSHOP` |
| Otros | `ACTIVE_BOOKING_EXISTS`; la BD impide un agente como confirmador; CRM caído no revierte la reserva; `openHumanCase` idempotente y rechaza seguridad; lecturas de odómetro concurrentes serializadas |

## 7. Errores encontrados durante la ejecución

1. **Tipos:** un error de estrechamiento en `journeyErrorToApp` y el tipo del comando de `openHumanCase`. Corregidos.
2. **Tests de fases anteriores:** creaban `BookingIntent` con el campo `confirmationToken` y un `Booking CONFIRMED` sin confirmador. Fallaron por los nuevos invariantes (comportamiento esperado) y se actualizaron sus datos.
3. **Orden de validación:** `prepareBooking` comprobaba la FSM antes que la reserva activa y devolvía `JOURNEY_STATE_INVALID` en lugar de `ACTIVE_BOOKING_EXISTS`. Corregido el orden y simplificado el test.
4. **Dos tests nuevos mal planteados:** comparaban el error de `NO_SLOTS` de forma demasiado estricta y usaban `Date.now()` (reloj real) en lugar del reloj demo. Corregidos.
5. **La migración generada por Prisma** eliminaba y recreaba la columna del token (destructivo). Reemplazada por `RENAME` + hash.

## 8. Riesgos restantes

- **Reconciliación con un taller real:** «no encontrada» no implica «no procesada». Hace falta una ventana de gracia o un webhook (D-37). Tampoco hay un job periódico que reconcilie las reservas `PENDING`.
- **Expiración:** las intenciones vencidas solo se expiran al intentar confirmarlas; no hay barrido proactivo.
- **Precios sintéticos:** tarifas y vigencia reales pendientes (D-38). El IVA mostrado lo devuelve el catálogo MOCK, no se calcula.
- **CRM:** la sincronización es de mejor esfuerzo sin cola de reintentos. Si el CRM cae, la interacción se pierde (la reserva no).
- **Cancelación:** la cancelación iniciada por el cliente y la reprogramación siguen fuera del MVP (D-21).
- **Límites de tasa:** sin rate limiting en confirmación y preparación hasta que existan los endpoints (Fases 5 y 7).
- **Compensación:** si falla la cancelación compensatoria, la reserva queda `PENDING` con un caso `DATA_CONFLICT`. Requiere operación humana.

## 9. Siguiente paso (requiere revisión)

Fase 5 — Tool Gateway, herramientas tipadas del agente sobre estos casos de uso, orquestador con `ScriptedLlm`, pre-clasificador de seguridad y output guard.
