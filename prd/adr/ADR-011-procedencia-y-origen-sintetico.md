# ADR-011 — Procedencia vs. origen sintético

**Estado:** Aceptada · **Fecha:** 2026-10-28 · **Afecta:** DATA_MODEL §1/§3/§5, ARCHITECTURE AD-6 y §4.4 (resuelve D-09), motor (`dataOrigin`)

## Contexto
`Provenance` mezclaba dos ejes: *quién respalda el dato* (taller, alistamiento, documento, cliente) y *si el dato es real o de demo* (`SIMULATED`). Un registro de demo que simula un cierre de taller no podía ser a la vez `WORKSHOP_VERIFIED` y `SIMULATED`. Además, el rótulo de los datos sintéticos dependía de banderas sueltas (`isSynthetic`, `isDemoRule`, `isSimulated`).

## Decisión
- `Provenance` = `WORKSHOP_VERIFIED | DELIVERY_INSPECTION | PRIOR_OWNER_DOCUMENT | OWNER_DECLARED`.
- Nuevo eje ortogonal `DataOrigin = REAL | SYNTHETIC` en toda entidad con datos de vehículo, plan, historial, políticas y órdenes de trabajo.
- Todo dato `SYNTHETIC` identifica su fuente con el prefijo **`SYNTHETIC-DEMO:`** (`sourceRef` en planes, `syntheticSourceRef` en el resto). Lo exige un `CHECK` en BD y lo valida el motor: si el rótulo no coincide con `dataOrigin`, devuelve `UNKNOWN[INVALID_INPUT]`.
- El motor devuelve `dataOrigin.syntheticSources[]` en cada evaluación, para que la UI y el agente lo muestren.
- Marca y motores ficticios («DemoMotors», `DEMO-*`); ningún intervalo se atribuye a un fabricante.

## Consecuencias
- AC11 se cumple con dos columnas legibles («Acreditado por taller · SIMULADO»).
- D-09 queda resuelta: el cierre de demo es `WORKSHOP_VERIFIED` + `SYNTHETIC`.
