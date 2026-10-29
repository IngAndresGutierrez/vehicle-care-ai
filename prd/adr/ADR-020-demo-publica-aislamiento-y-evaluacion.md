# ADR-020 — Demo pública: aislamiento entre visitantes, protección y evaluación agéntica

**Estado:** Aceptada (pendiente de revisión) · **Fecha:** 2026-10-29 · **Afecta:** `src/application/demo/demo-runs.ts`, `src/infra/{session,container}.ts`, `src/infra/http/{handlers,view-handlers}.ts`, `src/ui/**`, `next.config.ts`, `scripts/eval-agent.ts`

## Contexto
En la Fase 6 (ADR-019) todas las corridas de demo quedaban en la cartera del asesor fijo `act-advisor`, y `/api/demo/session` permitía entrar como cualquier cuenta `isDemo` conociendo su id. En una demo pública esto tenía tres consecuencias:
- un visitante podía ver y resolver los casos de otro, incluido el texto libre que el otro hubiera escrito;
- el escenario D dejaba en cero un horario del calendario compartido para siempre;
- el limitador por IP vive en memoria, así que no protege entre instancias serverless.

## Decisiones
1. **Un asesor por corrida.** `startDemoScenario` crea `demo-<run>-asesor` (rol ADVISOR, `isDemo`) con una cartera que contiene solo el cliente de esa corrida. Los casos de B y C se asignan a ese asesor mediante la regla existente (`portfolioAdvisorFor`). No cambia ninguna política de acceso ni regla de negocio.
2. **Cambio de persona restringido.** `POST /api/demo/scenarios` emite una cookie firmada (HMAC) `vc_demo_runs`, HttpOnly y con `Path=/api/demo`, que lista hasta 8 corridas iniciadas desde ese navegador. `/api/demo/session` solo acepta las personas `demo-<run>-propietario|asesor` de esas corridas. Las personas fijas del seed (`act-*`) solo se aceptan con `DEMO_SEED_PERSONAS=true`, para uso local. Cualquier otro intento responde **404 indistinto**.
3. **Tope global diario** (`DEMO_RUNS_PER_DAY`, 500 por defecto). Se cuenta sobre `AuditLog` (`DEMO_RUN_STARTED`), así que vale entre instancias. Se suma al límite por IP. Al alcanzarlo responde 429 `DEMO_DAILY_LIMIT`.
4. **Cupos del escenario D.** La simulación guarda el cupo previo en la auditoría. Cuando la intención ya venció (15 minutos), `restoreSimulatedSlots`, que corre al iniciar cualquier corrida, devuelve ese cupo una única vez y lo registra como `DEMO_SLOT_RESTORED`.
5. **Cabeceras de seguridad:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag: noindex` y sin `X-Powered-By`. No se usa CSP estricta porque Next inyecta scripts en línea; queda como trabajo para producción.
6. **Privacidad del texto libre:** el chat avisa «no escribas datos personales reales». Lo que escribe un visitante solo lo ven él y el asesor de su corrida.
7. **Evaluación agéntica** (`pnpm eval:agent`): 12 casos sobre una base desechable, cada uno en una corrida aislada. Las métricas se verifican por código: cifras de precio y km contrastadas con tarjetas y datos, reservas sin clic, seguridad, permisos, escalamiento, latencia y tokens. Con `EVAL_LLM=anthropic` se exigen `ANTHROPIC_API_KEY` **y** `EVAL_BUDGET_USD`; la ejecución se detiene al alcanzar el presupuesto. El precio por token se toma de la referencia del SDK y se puede sobrescribir por entorno.
8. **Accesibilidad:** axe-core (WCAG 2.1 A/AA) se ejecuta en Playwright sobre las cinco vistas, en escritorio y móvil. La prueba falla ante violaciones serias o críticas.

## Consecuencias
- En la demo pública, la bandeja de un visitante muestra solo los casos de sus propias corridas.
- La cookie de sesión y la de corridas llevan `Secure` en producción. Los navegadores aceptan `Secure` en `localhost`.
- El conteo diario recorre `AuditLog` sin un índice por `action`. Es aceptable con el volumen acotado de la demo; en producción habría que indexarlo.
