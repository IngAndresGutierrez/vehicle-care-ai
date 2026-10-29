# ADR-019 — Interfaz de demo, corridas aisladas y modelos de lectura

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-29 · **Afecta:** `src/app/**`, `src/ui/**`, `src/application/{demo,views}/**`, `src/infra/http/view-handlers.ts`, `src/application/run-evaluation-job.ts`

## Contexto
La Fase 6 entrega un prototipo navegable con los cuatro escenarios (A éxito, B historial insuficiente, C seguridad, D conflicto de cupo). Restricciones:
- Las tablas de auditoría son *append-only*: un «reset» destructivo no es posible ni deseable.
- La demo debe aislar a cada visitante, funcionar sin API key y rotular todo lo simulado.
- No puede haber endpoints públicos de seed o reset.

## Decisiones

**Corridas de demo en lugar de reset**
1. `POST /api/demo/scenarios` (solo `DEMO_MODE=true`, con límite por IP) **clona la plantilla del escenario** en datos nuevos:
   - cliente, propietario (`isDemo=true`) y vehículo nuevos;
   - consentimientos, titularidad, órdenes, servicios y lecturas de odómetro copiados;
   - cada fila es `SYNTHETIC` con `syntheticSourceRef = SYNTHETIC-DEMO:demo-run/<runId>/…`;
   - la placa es `DEMO<RUNID>`, sin datos reales.
   
   Después ejecuta el job de evaluación **solo para ese vehículo** (filtro opcional `vehicleIds` en `runEvaluationJob`) y entra con la sesión del propietario nuevo. No borra nada.
2. **Desplazamiento temporal:** fechas y horas se trasladan `now − DEMO_NOW` (días completos para columnas `@db.Date`). Así el motor produce el mismo resultado que con la plantilla (A: UPCOMING, faltan 800 km) en cualquier fecha. Las reglas del motor no cambian.
3. **Cartera del asesor:** las corridas quedan en la cartera de `act-advisor`, para que la bandeja muestre la resolución humana de B y C.
4. **Escenario D:** el conflicto se provoca con `POST /api/demo/slot-taken`, una acción del propietario sobre **su propia** intención pendiente que deja ese horario sin cupo. Ya no se usa el escenario MOCK global de la Fase 5, que afectaba a todos los visitantes.

**Calendario simulado compartido**

5. `ensureMockCalendar` crea, de forma idempotente, horarios para T1/T2 a 1–6 días: 08:00 y 14:00 de Bogotá. No duplica horarios existentes, como los del seed.
6. El cupo por horario es **50** (`DEMO_SLOT_CAPACITY`). Todos los visitantes comparten el calendario MOCK y con un cupo real (3) la demo se agotaba en horas: ocurrió durante las pruebas. Solo afecta datos MOCK. El conflicto de cupo se sigue demostrando de forma explícita en D, y el control real (`UPDATE … WHERE remaining > 0`) no cambia.

**Modelos de lectura (sin lógica de negocio nueva)**

7. `src/application/views/read-models.ts` compone casos de uso y políticas existentes:
   - `getMe`;
   - `getVehicleOverview`: perfil, historial, plan, última evaluación persistida, journey, reserva (folio solo si está `CONFIRMED`) e intención pendiente **sin token**;
   - `getTraceView`: eventos con lista blanca de claves, llamadas a herramientas con su resumen y entrada redactada, últimas evaluaciones con `decisionTrace` y huella de entrada truncada, marcas del output guard y base de acceso;
   - `getCasesInbox`: casos asignados al actor y casos sin asignar de su cartera, más las acciones permitidas según el estado del journey.
8. **Trazas:** cualquier actor con `READ_VEHICLE` (titular o asesor con cartera) puede leerlas. Compliance usa `AUDIT_READ` con justificación en la cabecera `x-audit-justification`, y cada consulta queda en `AuditLog`.

**HTTP**

9. Rutas nuevas:
   - `GET /api/me`;
   - `GET /api/vehicles/:id/overview` y `GET /api/vehicles/:id/trace`;
   - `GET /api/cases` y `POST /api/cases/:id/resolve` (llama a `resolveHumanCase`);
   - `GET /api/demo/config`, `POST /api/demo/scenarios` y `POST /api/demo/slot-taken`.
   
   Todas reutilizan `authenticate`, `problem`, `readJson` y `json` (`no-store`, `x-trace-id`). `GET /api/demo/config` llama a `connection()`: sin eso, Next lo prerenderizaba en el build y congelaba `DEMO_MODE` y el proveedor de LLM.
10. Si el caso es inexistente o ajeno, resolverlo responde **403**, nunca 404, para no revelar si el caso existe.

**Interfaz**

11. Next 16 App Router: páginas estáticas que montan componentes cliente que consumen la API. Los componentes que leen `useParams`/`useSearchParams` van dentro de `<Suspense>`. Tailwind v4 con tokens en `@theme`.
12. **Diseño «libreta de servicio»:** tinta petróleo, papel frío, ámbar (próximo), verde aceite (confirmado) y rojo freno (seguridad o vencido). Tipografía Barlow y Barlow Condensed. El elemento memorable es el odómetro con su regla de km, del último servicio al límite.
13. **Rotulado de lo simulado:** un sello de borde punteado marca vehículo y datos sintéticos, regla `SYNTHETIC-DEMO:`, catálogo, agenda y taller MOCK, y fuente MOCK en las trazas. El asistente muestra «Asistente simulado (ScriptedLlm)» y cada respuesta dice «Respuesta programada (simulación, no IA generativa)». Con `LLM_PROVIDER=anthropic` se rotula «IA generativa: <modelo>».
14. **Confirmación:** solo existe el botón «Confirmar reserva» de la tarjeta, que llama a `/api/bookings/confirm`. El token vive únicamente en memoria del navegador, nunca en `localStorage`. Mientras la confirmación está en curso el botón queda deshabilitado, y el backend es idempotente (`duplicate: true`). La interfaz traduce cada código del backend (`SLOT_CONFLICT`, `INTENT_EXPIRED`, `INVALID_TOKEN`, etc.) a un texto con la acción de recuperación.
15. **Cambio de persona:** el navegador recuerda en `localStorage` solo `runId`, `vehicleId` y `ownerActorId`. La sesión real es la cookie HttpOnly firmada, y `/api/demo/session` únicamente acepta cuentas `isDemo`.

## Consecuencias
- Cada corrida agrega filas que no se borran. La base de demo crece de forma acotada por el límite por IP (`DEMO_RUNS_PER_10_MIN`, 12 por defecto).
- El calendario MOCK es compartido: dos visitantes pueden chocar de verdad en un horario. La interfaz lo maneja igual que el escenario D.
- El limitador de tasa es en memoria y vale por instancia; en serverless no es global (ver README, despliegue).
