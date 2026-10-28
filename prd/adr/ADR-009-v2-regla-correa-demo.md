# ADR-009 — V2: regla demo validada de correa con historial insuficiente

**Estado:** Aceptada · **Fecha:** 2026-10-28 · **Afecta:** DATA_MODEL §5, IMPLEMENTATION_PLAN ME-23/E2E-02

## Contexto
El seed describía V2 con plan `VALIDATED` **sin** regla de correa y esperaba `UNKNOWN(INSUFFICIENT_HISTORY / RULE_MISSING_FOR_SERVICE)`. Son dos causas distintas: el motor corta en la primera (`RULE_MISSING_FOR_SERVICE`) y nunca ejercita EX-01 del PRD («sin constancia de cambio de correa»).

## Decisión
V2 tiene una regla de correa **validada y sintética** (`TIMING_BELT`, `appliesToTimingDrive=BELT`, 100.000 km / 72 meses, valores ficticios, `sourceRef` con prefijo `SYNTHETIC-DEMO:`), 95.000 km registrados y **ningún** `ServiceRecord` de correa. Resultado esperado: `UNKNOWN[INSUFFICIENT_HISTORY]` → `HUMAN_REVIEW`.

## Consecuencias
- EX-01 se prueba por el camino correcto (historial), no por la ausencia de regla. `RULE_MISSING_FOR_SERVICE` queda cubierto por ME-12.
- El intervalo ficticio nunca se muestra como dato de fabricante: el resultado lleva `dataOrigin.containsSyntheticData=true`.
- Con `UNKNOWN` el motor no expone `dueBy`, así que el intervalo ficticio no llega al propietario.
