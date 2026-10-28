# ADR-010 — Consentimiento: nomenclatura única y mensajes suprimidos

**Estado:** Aceptada · **Fecha:** 2026-10-28 · **Afecta:** ARCHITECTURE §4.1, DATA_MODEL `OutboundMessage`, AGENT_DESIGN §4

## Contexto
1. ARCHITECTURE §4.1 usaba `MAINTENANCE_REMINDER` y el enum `ConsentPurpose` define `MAINTENANCE_REMINDERS`.
2. `OutboundMessage.consentEventId` era obligatorio, pero un mensaje `SUPPRESSED` (EX-04) existe precisamente porque **no** hay opt-in que referenciar.

## Decisión
- La única finalidad de contacto proactivo por mantenimiento es `ConsentPurpose.MAINTENANCE_REMINDERS`, en todos los contratos.
- `OutboundMessage.consentEventId` es nullable con `CHECK`: `SIMULATED_SENT ⇒ consentEventId NOT NULL`; `SUPPRESSED ⇒ suppressionReason NOT NULL`.

## Consecuencias
- La supresión queda trazada (auditoría y métrica «contactable») sin inventar una evidencia de consentimiento.
- No es posible registrar un envío sin prueba de opt-in.
