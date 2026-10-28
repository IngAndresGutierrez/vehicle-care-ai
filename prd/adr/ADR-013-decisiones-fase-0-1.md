# ADR-013 — Decisiones provisionales adoptadas para Fases 0–1

**Estado:** Aceptada (provisional, reversible) · **Fecha:** 2026-10-28

| Decisión | Adoptado | Motivo / reversión |
|---|---|---|
| D-01 `DUE` vs `OVERDUE` | `OVERDUE` = límite técnico excedido en ≥ 500 km o ≥ 30 días (gracia de comunicación) | Parámetro de política; cambiarlo no toca el motor |
| D-02 aviso anticipado | 1.000 km / 30 días (`demo-comm-v1`, sintética) | Ejemplo del PRD §7 |
| D-03 antigüedad de odómetro | 30 días (`demo-dq-v1`); 30 días exactos todavía es concluyente | Parámetro |
| D-04 alistamiento como línea base | Solo si la regla tiene `allowDeliveryBaseline=true`; por defecto no | Lo valida el responsable técnico |
| D-05 fechas | Módulo propio `shared/local-date.ts` (Intl + días epoch, *clamp* a fin de mes), **sin `date-fns`** | Aritmética de calendario puro sin depender del TZ del proceso; ~60 líneas cubiertas por tests. Reemplazable |
| D-14 utilidades | `fast-check` (propiedades). Fronteras: ESLint `no-restricted-imports` en `src/domain/**` + test de frontera, **en lugar de `dependency-cruiser`** | Una dependencia menos; misma garantía para el alcance actual |
| D-15 Postgres de pruebas | Docker Compose `postgres:17-alpine` en puerto 54329, BD `vehicle_care` y `vehicle_care_test` | — |
| D-29 (nueva) servicio solo declarado | No sirve como línea base → `UNKNOWN[INSUFFICIENT_HISTORY, BASELINE_NOT_DOCUMENTED]`; `PRIOR_OWNER_DOCUMENT` sí | Evita recomendaciones basadas en afirmaciones sin evidencia |
| Instantes sin zona | Rechazados (`INVALID_INPUT`) | `Date.parse` sin zona depende del proceso |
| Versiones | Next.js 16.4.3, Vitest 5.0.5, **Prisma 7.10.1 estable** (la etiqueta `latest` de npm apunta a 8.0.0-rc) | Evitar una *release candidate* |
| Migración base | `00000000000000_baseline` vacía aplicada con `migrate deploy` | `migrate dev` no genera migraciones sin cambios de esquema |
| Logger e IDs | Logger JSON propio e IDs con `crypto.randomUUID` (sin pino ni ulid por ahora) | Mínimo para Fase 0; ampliable |

**Pendiente de validación externa:** D-01..D-04 y D-29 (producto + responsable técnico), D-30 (intervalos reales por referencia).
