# ADR-012 — Separar vencimiento técnico, comunicación y calidad de datos

**Estado:** Aceptada · **Fecha:** 2026-10-28 · **Afecta:** ARCHITECTURE §5, DATA_MODEL (`CommunicationPolicy`, `DataQualityPolicy`, `MaintenanceEvaluation`), AGENT_DESIGN `evaluateMaintenance`

## Contexto
`CommunicationPolicy` incluía `overdueGraceKm/Days` y `maxOdometerAgeDays`, y el algoritmo calculaba `OVERDUE/DUE/UPCOMING` en un solo paso. Eso permitía que un umbral comercial pareciera parte del intervalo técnico. El PRD (§7) exige que `lead_km`/`lead_days` sean «decisiones de comunicación, no intervalos técnicos».

## Decisión
1. **Técnico** (`technical.status`: `NOT_DUE | DUE | NOT_APPLICABLE | UNKNOWN`): solo depende del plan validado, la línea base y el odómetro. El límite es inclusivo.
2. **Comunicación** (`communication.status`: `NOT_DUE | UPCOMING | DUE | OVERDUE`): se deriva **después**, a partir del técnico y de `CommunicationPolicy { leadKm, leadDays, overdueGraceKm, overdueGraceDays }`.
3. **Calidad de datos**: `DataQualityPolicy { maxOdometerAgeDays }`, versionada por separado.
4. `status` consolidado = clasificación de comunicación, o `UNKNOWN`/`NOT_APPLICABLE`.

## Consecuencias
- Invariante comprobado por propiedad (ME-P4): ninguna política de comunicación cambia `technical`.
- `DUE` técnico nunca se rebaja a `UPCOMING`, y `UPCOMING` nunca se comunica como vencido.
- `MaintenanceEvaluation` persiste ambos estados y las dos versiones de política.
