/** Lo mínimo que necesita el health check: una consulta trivial a PostgreSQL. */
export interface HealthProbe {
  $queryRaw(query: TemplateStringsArray): Promise<unknown>;
}

/**
 * GET /api/health — health check de Railway. Comprueba el proceso y la conexión con PostgreSQL (`SELECT 1`, con tope
 * de tiempo). No expone el error, la URL ni la versión: solo `ok`/`error`. No requiere sesión ni SESSION_SECRET.
 */
export async function handleHealth(getDb: () => HealthProbe, timeoutMs = 3_000): Promise<Response> {
  const started = Date.now();
  let database: "ok" | "error" = "ok";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    await Promise.race([getDb().$queryRaw`SELECT 1`, timeout]);
  } catch (error) {
    database = "error";
    // Solo el tipo de fallo: el mensaje de `pg` puede incluir host o usuario.
    console.error(JSON.stringify({ level: "error", event: "health.db_unavailable", reason: error instanceof Error && error.message === "timeout" ? "timeout" : "connection" }));
  } finally {
    clearTimeout(timer);
  }
  const ok = database === "ok";
  return new Response(JSON.stringify({ status: ok ? "ok" : "error", database, latencyMs: Date.now() - started }), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
