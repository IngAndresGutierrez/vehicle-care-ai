# Despliegue — auditoría y pasos exactos (Vercel + PostgreSQL)

**Estado real (2026-10-29): NO desplegado. No hay URL pública.** El entorno no tiene CLI de Vercel ni token (`VERCEL_TOKEN`), ni proyecto vinculado (`.vercel/`). No se crearon recursos, ni de pago ni gratuitos.

## 1. Auditoría de configuración

| Área | Estado | Evidencia o acción |
|---|---|---|
| Build sin secretos | ✔ **Corregido en el cierre** | `prisma generate` (postinstall) fallaba sin `DATABASE_URL` y `next build` ejecutaba `GET /api/cases` exigiendo `SESSION_SECRET`. Ahora `prisma.config.ts` admite generar sin URL y las rutas `GET` usan `connection()`. Comprobado: `next build` sin `.env`, sin `DATABASE_URL` y sin `SESSION_SECRET` → exit 0 |
| Runtime | ✔ | Node.js por defecto (Fluid Compute), `engines.node >=24`. Sin `runtime = "edge"` |
| Gestor de paquetes | ⚠ Verificar | `packageManager: pnpm@12.8.1`. Si Vercel instala otra versión, definir `ENABLE_EXPERIMENTAL_COREPACK=1` para que respete `packageManager` |
| PostgreSQL | Pendiente | PostgreSQL gestionado desde el Marketplace de Vercel (p. ej. Neon). Elegir explícitamente el **plan gratuito**; el plan es decisión del usuario |
| Prisma en serverless | ✔ con recomendación | Prisma 7 con `@prisma/adapter-pg` y un cliente por instancia (`getPrisma`). En runtime usar la **URL con pooling** (`DATABASE_URL`) y, para migraciones, la **URL directa sin pooling** |
| Migraciones | ✔ | 10 migraciones aditivas. Usar **solo `prisma migrate deploy`**, nunca `migrate reset` ni `db push` en el entorno desplegado. `pnpm db:verify-migrations` las valida desde cero, sin drift |
| Seed | ✔ | `pnpm db:seed` es idempotente y no modifica una base ya sembrada. Solo datos sintéticos (`SYNTHETIC-DEMO:`) |
| Secretos | ✔ | `.env*` ignorado (solo `.env.example` versionado). `SESSION_SECRET` < 32 caracteres hace fallar el arranque. `LOG_HASH_SECRET` debe ser distinto |
| Cookies | ✔ | `vc_session`: HttpOnly, SameSite=Lax, Secure en producción, 8 h. `vc_demo_runs`: HttpOnly, `Path=/api/demo`, firmada (HMAC), Secure. Verificado con `curl` sobre `next start` |
| CSRF | ✔ | Cookies SameSite=Lax; los POST con cuerpo exigen `application/json` (415 si no) |
| Sesiones demo | ✔ | Solo con `DEMO_MODE=true`. Cambio de persona limitado a corridas del mismo navegador; personas del seed bloqueadas salvo `DEMO_SEED_PERSONAS=true` (ADR-020) |
| Endpoints administrativos | ✔ | No hay seed ni reset por HTTP. Las rutas demo responden 404 sin `DEMO_MODE` |
| Abuso | ✔ con límite | Por IP (en memoria, por instancia) y **tope diario global en la base** (`DEMO_RUNS_PER_DAY`). Turnos y confirmaciones por actor |
| Cabeceras | ✔ | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag: noindex`, sin `X-Powered-By`. Sin CSP estricta |
| LLM | ✔ seguro por defecto | `LLM_PROVIDER=scripted`: sin costo, rotulado como simulación. Activar `anthropic` en una demo pública expone gasto: solo con presupuesto aprobado |
| Duración de funciones | ✔ | Turno ≤ 45 s (`AGENT_TURN_TIMEOUT_MS`), por debajo del límite por defecto de Vercel |
| Datos personales | ✔ | Solo datos sintéticos; aviso en el chat para no escribir datos reales. Placa enmascarada; sin VIN |

## 2. Pasos exactos

Requiere una cuenta de Vercel. Los comandos se ejecutan en la raíz del repositorio.

```bash
# 0) CLI y sesión
npm i -g vercel
vercel login

# 1) Proyecto (Framework: Next.js; Root: ./ ; Build: next build ; Install: pnpm install)
vercel link

# 2) Base de datos: Dashboard → proyecto → Storage → Marketplace → Postgres (p. ej. Neon) → plan GRATUITO
#    → «Connect» a Production y Preview. Inyecta DATABASE_URL (pooling) y una URL directa (p. ej. DATABASE_URL_UNPOOLED).

# 3) Variables (Production; repetir para Preview si se usará)
openssl rand -base64 48 | vercel env add SESSION_SECRET production
openssl rand -base64 48 | vercel env add LOG_HASH_SECRET production
printf 'true'      | vercel env add DEMO_MODE production
printf 'scripted'  | vercel env add LLM_PROVIDER production
printf '12'        | vercel env add DEMO_RUNS_PER_10_MIN production
printf '500'       | vercel env add DEMO_RUNS_PER_DAY production
printf 'false'     | vercel env add DEMO_SEED_PERSONAS production
# Solo si pnpm 12 no se respeta:  printf '1' | vercel env add ENABLE_EXPERIMENTAL_COREPACK production

# 4) Migrar y sembrar UNA vez, con la URL directa (no la de pooling), desde tu máquina
vercel env pull .env.vercel --environment=production
DATABASE_URL="$(grep '^DATABASE_URL_UNPOOLED=' .env.vercel | cut -d= -f2- | tr -d '\"')" pnpm db:migrate:deploy
DATABASE_URL="$(grep '^DATABASE_URL_UNPOOLED=' .env.vercel | cut -d= -f2- | tr -d '\"')" pnpm db:seed
rm .env.vercel   # no dejar secretos en disco

# 5) Preview, verificación y producción
vercel deploy                 # imprime la URL de preview
E2E_BASE_URL=<url-preview> pnpm test:e2e --project=desktop   # si la preview tiene Deployment Protection, usar un bypass o probar en producción
vercel deploy --prod
```

**Verificación después de publicar** (sustituye `<url>` por la URL real que imprima Vercel):

```bash
curl -s <url>/api/demo/config      # demoMode:true, llm.provider:"SCRIPTED", llm.simulated:true
curl -sI <url>/ | grep -iE "x-frame|nosniff|robots"
curl -s -o /dev/null -w "%{http_code}\n" <url>/api/me     # 401 sin sesión
E2E_BASE_URL=<url> pnpm test:e2e   # 25 pruebas: A–D, seguridad, axe
```

**Reversión:** `vercel rollback`, o promover el despliegue anterior desde el dashboard. Las migraciones son aditivas: no requieren reversión de esquema.

## 3. Riesgos que quedan

- El limitador por IP no es global. El tope diario sí lo es; si hiciera falta un límite global por IP, se puede agregar Redis desde el Marketplace (plan a decidir).
- Las corridas de demo agregan filas que no se borran (auditoría *append-only*). Vigilar el tamaño de la base del plan gratuito y bajar `DEMO_RUNS_PER_DAY` si se acerca al límite.
- Las previews con Deployment Protection piden autenticación de Vercel. Para el comité, compartir la URL de producción.
