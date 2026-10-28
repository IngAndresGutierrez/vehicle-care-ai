# ADR-014 — Persistencia de Fase 2: ajustes de esquema e invariantes

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-28 · **Afecta:** DATA_MODEL §3–§5, `prisma/`, `src/application/`

## Contexto
Al implementar el esquema de DATA_MODEL §3 aparecieron huecos entre el borrador, el motor (Fase 1) y los invariantes de §4.

## Decisiones

**Esquema**
1. `ServiceRecord.performedAt` → **`performedOn`** (`@db.Date`), igual que el motor y AGENT_DESIGN.
2. `Booking.serviceCode` desnormalizado desde `Quote`, para el índice único parcial «una reserva `CONFIRMED` por vehículo y servicio».
3. `syntheticSourceRef` también en `CommunicationPolicy`, `DataQualityPolicy` y `OutboundMessage`; `DataQualityPolicy.dataOrigin`. Así toda tabla con `dataOrigin` cumple la misma regla de rótulo (ADR-011).
4. `OutboundMessage.consentEventId` es una FK real a `ConsentEvent`: la evidencia citada debe existir.
5. `MaintenanceEvaluation` guarda instantáneas de `planVersionLabel`, `planSourceRef` y `asOfLocalDate`, para que la evaluación sea autoexplicativa aunque el plan evolucione.

**Invariantes SQL** (migraciones `phase2_*`)

6. Append-only (trigger `vc_forbid_mutation`, SQLSTATE `P0A01`) en `JourneyEvent`, `ToolCall`, `ConsentEvent`, `MaintenanceEvaluation`, `AuditLog`, **`OdometerReading`, `ServiceRecord` y `OutboundMessage`**. Las tres últimas pasan de «principio» a garantía de BD. Se cambió el SQLSTATE inicial (`23001`) porque Prisma lo reportaba como violación de FK.
7. `MaintenanceRule.appliesToTimingDrive` solo admite `BELT`/`CHAIN`/NULL. Una regla con `UNKNOWN` es corrupción: el builder lanza error en vez de reinterpretarla.
8. Todas las condiciones sobre columnas opcionales usan `IS [NOT] NULL` explícito. Un `CHECK` que evalúa a NULL **se acepta** en PostgreSQL. Los tests encontraron dos casos (rótulo sintético NULL y `communicationStatus` NULL), corregidos en `phase2_null_safe_checks`.

**Aplicación**

9. El `EvaluationContextBuilder` solo selecciona y mapea datos: versión `VALIDATED` vigente más reciente (si no hay, la última en cualquier estado, para que el motor diga `PLAN_NOT_VERIFIED`); excluye lecturas `REJECTED` y registros reemplazados (`supersedesId`). Dos planes aplicables a la misma especificación → error `AMBIGUOUS_PLAN`, sin persistir.
10. Recordatorios: canal por prioridad `WHATSAPP → EMAIL → SMS` sobre `MAINTENANCE_REMINDERS`. Sin canal autorizado se registra un `OutboundMessage SUPPRESSED` con el canal preferido y `suppressionReason=CONSENT_REQUIRED`. `SIMULATED_SENT` solo deja constancia: no hay proveedor de mensajería.
11. Un vehículo inexistente responde `UNAUTHORIZED`, igual que uno ajeno, para no revelar su existencia.

**Operación**

12. `prisma migrate reset` está bloqueado para agentes de IA sin consentimiento explícito del usuario. La reproducibilidad se verifica con `pnpm db:verify-migrations`: base **desechable** con nombre único → `migrate deploy` → `migrate diff --exit-code` → seed → `DROP`. No toca `vehicle_care` ni `vehicle_care_test`.
13. Los tests de integración aplican `migrate deploy` a `vehicle_care_test` y hacen `TRUNCATE` + seed antes de cada test. Se niegan a ejecutarse si la URL no apunta a una base `*_test`.

## Consecuencias
- En producción, el rol de la aplicación no debe tener privilegio `TRUNCATE` (no dispara triggers de fila).
- La transición `CONTACT_SUPPRESSED` del journey (parte de IT-05) llega con la FSM en la Fase 3.
