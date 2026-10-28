# ADR-016 — Mínimo privilegio para asesores y compliance

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-28 · **Afecta:** `access-policy.ts`, `vehicle-access.ts`, `resolve-human-case.ts`, AGENT_DESIGN §4.1

## Contexto
En la Fase 2, `ADVISOR` y `COMPLIANCE` podían leer y evaluar **cualquier** vehículo (matriz original de AGENT_DESIGN §4.1). Fue un hallazgo P0 de la revisión: acceso no justificado a datos personales (Ley 1581, principio de acceso restringido).

## Decisiones
1. **Asesor:** accede a un vehículo solo si (a) el titular **vigente** está en su cartera activa (`PortfolioAssignment`) o (b) tiene asignado un caso abierto sobre ese vehículo. La cartera del titular anterior no concede acceso. Sin `AUDIT_READ`.
2. **Compliance:** sin acceso operativo (no lee perfiles ni evalúa). Puede (a) leer el vehículo de un caso que tiene asignado o (b) usar `AUDIT_READ` con una justificación de al menos 15 caracteres. La aplicación debe registrar esa justificación en `AuditLog` cuando exista el panel de auditoría (Fase 6). Hoy solo lo exige la política.
3. **Resolución de casos:** solo `ADVISOR`/`COMPLIANCE` **asignados** (`HumanCase.assigneeId`) y con el caso abierto. Un caso sin asignar debe asignarse primero (operación de supervisión, Fase 6). Agente, job, propietario y taller nunca resuelven.
4. Los casos de seguridad se asignan automáticamente al asesor de cartera del titular vigente. Sin cartera, quedan `OPEN` sin asignar, y eso es visible como riesgo operativo.
5. Seed demo: el asesor atiende a C1 y C2; C3 queda fuera a propósito, para demostrar la denegación. El seed completa las asignaciones de forma idempotente también en bases ya sembradas.

## Implicaciones para producción
- Debe existir un proceso de asignación de cartera (desde el CRM o el DMS) y de reasignación de casos con SLA. Sin él, los casos de clientes sin asesor quedan sin dueño.
- Hace falta un rol de **supervisor** (no modelado) que asigne casos y vea colas sin acceso a datos personales completos.
- `AUDIT_READ` necesita retención y revisión periódica de las justificaciones. La política no evalúa su calidad, solo su presencia.
- El alcance por **agencia o sede** no está modelado (un solo concesionario demo). Con varias agencias, la cartera debe acotarse además por agencia.
