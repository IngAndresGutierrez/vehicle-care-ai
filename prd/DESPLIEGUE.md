# Despliegue — Railway (demo pública)

**Estado real (2026-10-29): desplegado y verificado.**

**URL pública:** https://vehicle-care-web-production-c5e6.up.railway.app

> Demo pública con **datos sintéticos** y **Claude real** (Sonnet 5.5) bajo un **tope global de gasto de USD 5 / 24 h**.
> No es un entorno autorizado para clientes reales (D4, D6). El despliegue anterior previsto en Vercel queda descartado.

## 0. Política del despliegue

1. **Solo datos sintéticos.** `DEMO_SEED_PERSONAS=false`: los visitantes no pueden entrar como las personas fijas del seed.
2. **LLM real con tope de gasto (decisión del usuario del 2026-10-29).** La primera publicación usó `ScriptedLlm`. Después, a petición del usuario, se activó `LLM_PROVIDER=anthropic` **para todos los visitantes**, con la API key del entorno local del usuario y un **tope global de USD 5 en 24 h** (`LLM_DAILY_BUDGET_USD`). El tope se desplegó **antes** de activar el proveedor. Para volver a la simulación: `railway variable set LLM_PROVIDER=scripted -s vehicle-care-web`.
3. **Sin recursos adicionales de pago.** Dos servicios dentro del plan actual de la cuenta. Sin cambios de plan ni add-ons.
4. **Secretos solo en Railway**, generados con `openssl rand -base64 48` y cargados por `stdin` (nunca en argumentos, logs ni repositorio).
5. **Migraciones solo aditivas** con `prisma migrate deploy`. Nunca `migrate reset`, `db push` ni borrado de tablas.

## 1. Infraestructura

| Elemento | Valor |
|---|---|
| Proyecto | `vehicle-care-ai` (ID `7a77aab8-3e29-4588-bd6d-9f46baac3668`), entorno `production` |
| `vehicle-care-web` | App Next.js completa (UI + API). Fuente: GitHub `IngAndresGutierrez/vehicle-care-ai`, rama `main`. Builder Railpack. **1 réplica en US East** (`us-east4`) |
| `Postgres` | Plantilla oficial `postgres-ssl:18`, volumen persistente `postgres-volume` (4.9 GB). **US East**. **Sin proxy TCP público**: solo red privada `postgres.railway.internal:5432` |
| Dominio | `vehicle-care-web-production-c5e6.up.railway.app` (generado por Railway, HTTPS con certificado gestionado, HTTP → 301 a HTTPS), puerto destino 8080 |

La región se movió de *Southeast Asia* (valor por defecto) a *US East*, la más cercana a Colombia. La app y la base están en la misma región.

## 2. Configuración de build y arranque (`.railway/railway.ts`)

La configuración vive en el repositorio como **Infraestructura como Código** de Railway (`.railway/railway.ts`, SDK `railway` como devDependency). Gestiona **solo** el servicio `vehicle-care-web` (`partial`) y deja las variables **sin gestionar** (`variables: { managed: false }`): los secretos nunca aparecen en el archivo.

| Paso | Comando | Notas |
|---|---|---|
| Instalación | `pnpm install` (Railpack) | Node **24.22.0** (de `engines.node`) y pnpm **12.8.1** (de `packageManager`). `postinstall` ejecuta `prisma generate` |
| Build | `pnpm build` | `next build`. No necesita secretos ni base: las rutas dinámicas usan `connection()` |
| Pre-deploy | `pnpm db:migrate:deploy` | Se ejecuta en la imagen construida, con acceso a la red privada; Prisma CLI está disponible porque Railpack no elimina devDependencies. Si falla, el despliegue no se activa y sigue el anterior |
| Arranque | `pnpm exec next start --hostname 0.0.0.0` | Escucha en `0.0.0.0:$PORT` (Railway inyecta `PORT=8080`) |
| Health check | `GET /api/health`, tope 120 s | Ver §6 |
| Reinicio | `ON_FAILURE`, 10 reintentos | |

**`output: "standalone"` descartado:** no aporta una ventaja clara en Railway (no hay límite de tamaño de imagen relevante) y el pre-deploy necesita Prisma CLI y las migraciones, que no viajan en el bundle *standalone*. Se conserva el arranque convencional.

**No se define `NODE_ENV` como variable del servicio:** en el build haría que pnpm omitiera las devDependencies (TypeScript, Tailwind, Prisma CLI). `next start` fija `NODE_ENV=production` en ejecución.

> `railway.json` (Config as Code) se probó primero y **Railway lo ignoró** en este servicio (pre-deploy y health check nulos); además, ese formato deja de funcionar el 2026-12-01. Se migró con `railway config migrate`.

## 3. Variables de entorno (`vehicle-care-web`)

| Variable | Valor | Notas |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Referencia de Railway; resuelve a `postgres.railway.internal` (red privada) |
| `SESSION_SECRET` | secreto (64 caracteres) | Aleatorio, solo en Railway. Menos de 32 caracteres hace fallar el arranque |
| `LOG_HASH_SECRET` | secreto (64 caracteres) | Independiente del anterior |
| `DEMO_MODE` | `true` | |
| `DEMO_SEED_PERSONAS` | `false` | |
| `DEMO_RUNS_PER_DAY` | `50` | Tope global en la base, 24 h móviles |
| `DEMO_RUNS_PER_10_MIN` | `12` | Por IP (`X-Real-IP`), en memoria |
| `LLM_PROVIDER` | `anthropic` | Era `scripted` en la primera publicación |
| `ANTHROPIC_API_KEY` | secreto | Cargada por `stdin` desde el `.env` local del usuario; nunca impresa. Verificado: no aparece en los logs |
| `LLM_DAILY_BUDGET_USD` | `5` | Tope global de gasto estimado en 24 h, contado en la base (ver §5) |
| `LLM_MODEL` / `LLM_EFFORT` | `claude-sonnet-5-5` / `medium` | |

Opcionales con valor por defecto en el código: `AGENT_TURNS_PER_MINUTE` (20), `BOOKING_CONFIRMS_PER_MINUTE` (10), `AGENT_TURN_TIMEOUT_MS` (45000), `AGENT_MAX_ITERATIONS` (6), `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_SERVER_FALLBACKS`, `LLM_PROMPT_CACHE`.

Rotar un secreto: `openssl rand -base64 48 | tr -d '\n' | railway variable set SESSION_SECRET --stdin -s vehicle-care-web` (cierra las sesiones vigentes).

## 4. Migraciones y seed

- **13 migraciones** aplicadas por el pre-deploy del primer despliegue (`00000000000000_baseline` … `20261029190000_message_turn_metrics`). `prisma migrate status` dentro del contenedor: *Database schema is up to date*.
- **Seed ejecutado una sola vez**, dentro del contenedor de Railway (red privada) por SSH: `pnpm db:seed` → «Seed sintético aplicado». No forma parte del arranque ni del pre-deploy. Es idempotente: repetirlo no modifica una base ya sembrada.
- Contenido verificado tras el seed: 3 clientes y 4 vehículos (todos `dataOrigin = SYNTHETIC`), 8 cuentas de actor, 2 talleres, 1 plan, 2 reglas, políticas de comunicación y de calidad de datos, 7 cupos del taller simulado.

**Cómo se ejecutó el seed (mecanismo verificable):** `railway ssh` exige una clave registrada en la cuenta. Se creó una clave ed25519 **temporal** fuera de `~/.ssh`, se registró con `railway ssh keys add` desde un `ssh-agent` aislado, se usó para `migrate status`, `db:seed` y las verificaciones, y después **se eliminó de Railway y del disco**.

```bash
# Repetir una operación puntual (p. ej. migrate status) dentro del contenedor:
railway ssh -s vehicle-care-web -- pnpm db:status
```

## 5. Seguridad de la demo pública (verificado en la URL)

| Control | Resultado |
|---|---|
| Identidades | Solo sintéticas (`SYNTHETIC`); `DEMO_SEED_PERSONAS=false`. E2E: no se puede entrar como personas de otra corrida ni del seed |
| Aislamiento | Cada escenario crea propietario, vehículo y asesor nuevos. E2E: acceso cruzado entre propietarios y asesor ajeno → denegado |
| Endpoints | Sin seed ni reset por HTTP. `/api/me` sin sesión → 401. POST sin `application/json` → 415 |
| Cookies | `vc_session` y `vc_demo_runs`: `HttpOnly; Secure; SameSite=Lax; Max-Age=28800` (comprobado en producción) |
| HTTPS | Solo HTTPS; HTTP → 301. Cabeceras `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag: noindex` |
| Límites | 12 corridas por IP cada 10 min y 50 diarias globales. **Corregido en el despliegue** (ver §9): ya no se pueden evadir con cabeceras falsas |
| Claude real | Activo para todos los visitantes. Controles: tope global **USD 5 / 24 h** (al alcanzarlo, `/api/agent/turn` → 429 `LLM_DAILY_BUDGET` y la interfaz lo explica), 20 turnos/min por actor, tope de tokens de salida por turno, 12 escenarios/IP cada 10 min y 50 escenarios/día. Limitaciones del tope: es una estimación con tarifas de referencia, puede excederse levemente con turnos concurrentes (se comprueba antes del turno) y no cuenta turnos que fallan tras llamar al modelo. **Recomendado:** límite de gasto en la consola de Anthropic como respaldo |
| PostgreSQL | No expuesto a Internet. Caída de la base → `/api/health` 503 sin detalles (probado en local con una URL inválida) |
| Logs | Sin tokens de reserva ni secretos en los logs de Railway (ver §6) |

## 6. Health check y observabilidad

`GET /api/health` → `200 {"status":"ok","database":"ok","latencyMs":…}` o `503 {"status":"error","database":"error",…}`. Ejecuta `SELECT 1` con tope de 3 s, no requiere sesión ni `SESSION_SECRET`, responde `no-store` y **no expone** el mensaje de error, la URL ni la versión (el log solo registra `timeout` o `connection`). Railway lo usa al desplegar: un despliegue que no lo supera no reemplaza al anterior.

Sin herramientas externas: basta con Railway y las trazas existentes (`x-trace-id`, tabla `ToolCall`, métricas por turno en `ConversationMessage`).

```bash
railway logs -s vehicle-care-web                        # logs de ejecución (inicio, errores de API/DB)
railway logs -s vehicle-care-web --http -n 100          # peticiones HTTP: ruta, estado, latencia, IP
railway logs -s vehicle-care-web --filter "@level:error"
railway metrics -s vehicle-care-web                     # CPU, memoria, red, HTTP 2xx/4xx/5xx
railway deployment list -s vehicle-care-web             # historial (reinicios, fallos)
```

Consistencia de reservas: `select status, count(*) from "Booking" group by 1` dentro del contenedor (ver §4); la unicidad la garantizan las restricciones de la base (Fase 4).

## 7. Resultado de las pruebas

| Prueba | Entorno | Resultado |
|---|---|---|
| Lint + typecheck + 205 unitarias + 193 de integración | Local y GitHub Actions (CI) | ✔ Todas pasan, sin Anthropic real |
| Build sin secretos ni base | Local y Railway | ✔ |
| `/api/health` | URL pública | ✔ 200 `database: ok`; 503 sin detalles con la base caída (local) |
| HTTPS, redirección HTTP, cabeceras, 401 sin sesión, cookies `Secure` | URL pública | ✔ |
| Limitador por IP y evasión con cabeceras falsas | URL pública | ✔ tras la corrección (§9) |
| E2E Playwright, escritorio, primera pasada (con ScriptedLlm) | URL pública | **Parcial:** 11 pasaron y 4 fallaron. La pasada se hizo desde una sola IP y agotó el límite de 12 escenarios por IP; los 4 fallos coinciden con ese límite, pero no se confirmó caso por caso. Una segunda pasada inmediata falló entera por 429 |
| E2E móvil y repetición completa de A–D | — | **No ejecutadas:** se detuvieron a petición del usuario. Además, la suite exige ScriptedLlm (`global-setup`) y ahora el entorno usa Claude real |
| Persistencia tras reinicio | URL pública | ✔ Tras `railway service restart`: 18 vehículos y 3 reservas confirmadas siguen en PostgreSQL |
| Turno con Claude real | URL pública | ✔ Escenario A: 4 herramientas (perfil, historial, plan, evaluación), estado `RECOMMENDATION_PRESENTED`, 6,8 s, USD 0,018 estimados |

Para repetir las E2E contra la URL hay que volver temporalmente a `LLM_PROVIDER=scripted` y correrlas por lotes de 12 escenarios como máximo (o desde varias IP): `E2E_BASE_URL=<url> pnpm test:e2e --project=desktop`.

## 8. CI/CD

- **CI** (`.github/workflows/ci.yml`, GitHub Actions): en cada push a `main` y en cada PR ejecuta `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` contra un **PostgreSQL efímero del runner** (`vehicle_care_test`, nunca la base de producción) y `pnpm build`. Sin Anthropic real (`LLM_PROVIDER=scripted`, API key vacía).
- **CD:** el despliegue automático desde `main` **está pendiente de una autorización**: Railway responde *«no one in the project has access to it»* al crear el trigger, porque la GitHub App de Railway no tiene acceso al repositorio (hasta ahora Railway clona el repo porque es público). Para activarlo:
  1. GitHub → *Settings → Applications → Railway → Configure* (o instalar desde el dashboard de Railway, *Account → Integrations → GitHub*) y dar acceso a `IngAndresGutierrez/vehicle-care-ai`.
  2. Dashboard de Railway → `vehicle-care-web` → *Settings → Source* → rama `main`, activar **«Wait for CI»**. Con eso Railway solo despliega commits cuyo CI pasó.
- Mientras tanto, cada despliegue se dispara manualmente **después** de que el CI pase:

  ```bash
  railway api 'mutation { serviceInstanceDeployV2(serviceId: "57d19b9c-e5ad-46e7-ab69-f779b4d8d33d", environmentId: "c043eb3a-3fce-40ab-ba7f-b1e64d1bb2a5", commitSha: "<sha de main>") }'
  ```
- **Migraciones controladas:** solo el pre-deploy las aplica (`migrate deploy`, aditivas). Un cambio de esquema se valida antes en CI y con `pnpm db:verify-migrations`.
- Cambios de configuración de Railway: editar `.railway/railway.ts`, `railway config plan` (vista previa) y `railway config apply`.

## 9. Errores encontrados y corregidos

1. **`railway.json` ignorado:** el primer despliegue arrancó sin pre-deploy ni health check y con las 13 migraciones pendientes. Migrado a `.railway/railway.ts`; el siguiente despliegue aplicó las migraciones.
2. **Dos réplicas por defecto:** asignar la región creó una réplica en US East además de la de Southeast Asia (doble costo y limitador inconsistente). Fijado `southeast-asia=0`, `us-east=1`.
3. **`NODE_ENV=production` como variable:** habría roto el build (pnpm omite devDependencies). Eliminada antes del primer build.
4. **Evasión del límite por IP (seguridad):** el limitador tomaba la primera entrada de `X-Forwarded-For`, que en Railway controla el cliente: con una IP falsa se iniciaban corridas estando limitado (comprobado: 200 tras 429). Un primer arreglo con la última entrada resultó incorrecto en producción (es una IP del pool de proxies, compartida entre visitantes: 400/429 intercalados). Arreglo final: `X-Real-IP`, que el edge de Railway sobrescribe. Verificado en la URL: exactamente 12 permitidas y luego 429; cabeceras falsas no evitan el límite; otra IP tiene su propio cupo. Prueba unitaria en `src/infra/http/__tests__/client-ip.test.ts`.
5. **Sin endpoint de salud:** añadido `/api/health` con pruebas unitarias.
6. **Sin tope de gasto del LLM:** requisito para activar Claude en público. Añadido `LLM_DAILY_BUDGET_USD` (`src/infra/llm-budget.ts`, comprobado en `handleAgentTurn`), con pruebas de integración. Un valor inválido hace fallar el arranque en lugar de desactivar el tope.
7. **Visitante bloqueado por las pruebas:** las E2E agotaron el cupo por IP de la red del usuario. Se resolvió reiniciando el servicio (el limitador vive en memoria).

## 10. Costos y recursos

- Plan actual de la cuenta, con facturación por uso. No se cambió el plan ni se activaron add-ons, réplicas extra, proxies TCP ni dominios personalizados.
- Consumo observado en la primera hora: web ≈ 105 MB de RAM en promedio (pico 573 MB en el build/arranque), CPU < 0.01 vCPU; Postgres ≈ 60–140 MB de RAM y 0.1 GB de volumen. Estimación orientativa: unos pocos USD al mes para ambos servicios en reposo; consultar `railway usage`.
- **Anthropic:** hasta USD 5/día estimados (≈ 270 turnos a USD 0,018), facturados en la cuenta de la API key local del usuario.
- **Recomendación (requiere tu aprobación):** fijar un límite de gasto del workspace con `railway usage limit` (la cuenta no tiene *soft* ni *hard limit*).
- Crecimiento de la base: las corridas añaden filas *append-only*; con 50 corridas/día el volumen crece despacio. Vigilar `railway metrics -s Postgres`.

## 11. Rollback y recuperación

- **Revertir la aplicación:** dashboard → `vehicle-care-web` → *Deployments* → despliegue anterior → **Redeploy** (o `serviceInstanceDeployV2` con el `commitSha` anterior). Railway no activa un despliegue que no supera el health check, así que un fallo de arranque deja el anterior en servicio.
- **No revertir migraciones automáticamente.** Son aditivas: el código anterior funciona con el esquema nuevo. Si una migración futura fuera incompatible, corregir hacia adelante con una migración nueva; nunca `migrate reset`, `db push` ni editar migraciones aplicadas.
- **Reinicio:** `railway service restart -s vehicle-care-web`. Los datos persisten en el volumen de Postgres (verificado, §7).
- **Base de datos:** volumen persistente. Para respaldos, `railway connect Postgres` (psql) o `pg_dump` desde el contenedor; *point-in-time recovery* está disponible con `railway postgres` (posible costo: requiere aprobación).
- **Base caída:** `/api/health` devuelve 503 sin detalles (probado en local, no se detuvo la base de producción). El pool de `pg` reabre conexiones al volver Postgres; si no se recupera, `railway service restart`.
- **Cortar el gasto del LLM de inmediato:** `railway variable set LLM_PROVIDER=scripted -s vehicle-care-web` (redespliega con la simulación) o revocar la key en la consola de Anthropic.
- **Desactivar la demo de inmediato:** `railway variable set DEMO_MODE=false -s vehicle-care-web` (las rutas demo responden 404) o eliminar el dominio con `railway domain delete`.
