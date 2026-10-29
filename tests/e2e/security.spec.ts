import { expect, request as pwRequest, test } from "@playwright/test";
import { apiRun, apiToIntent, apiTurn, say, startScenario, openAssistant } from "./helpers";

const base = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? 3100}`;

test.describe("Seguridad y errores", () => {
  test("confirmación duplicada no crea dos reservas @api", async () => {
    const ctx = await pwRequest.newContext({ baseURL: base });
    const run = await apiRun(ctx, "A");
    const { token } = await apiToIntent(ctx, run.vehicleId);
    const [r1, r2] = await Promise.all([ctx.post("/api/bookings/confirm", { data: { confirmationToken: token } }), ctx.post("/api/bookings/confirm", { data: { confirmationToken: token } })]);
    const ok = [r1, r2].filter((r) => r.status() === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(await Promise.all(ok.map(async (r) => ((await r.json()) as { booking: { bookingId: string } }).booking.bookingId)));
    expect(ids.size).toBe(1);
    const r3 = await ctx.post("/api/bookings/confirm", { data: { confirmationToken: token } });
    expect(r3.status()).toBe(200);
    expect(((await r3.json()) as { booking: { bookingId: string; duplicate: boolean } }).booking).toMatchObject({ bookingId: [...ids][0], duplicate: true });
    await ctx.dispose();
  });

  test("acceso cruzado: un propietario no ve ni confirma lo de otro @api", async () => {
    const a = await pwRequest.newContext({ baseURL: base });
    const b = await pwRequest.newContext({ baseURL: base });
    const runA = await apiRun(a, "A");
    const runB = await apiRun(b, "A");
    const { token: tokenB } = await apiToIntent(b, runB.vehicleId);

    expect((await a.get(`/api/vehicles/${runB.vehicleId}/overview`)).status()).toBe(403);
    expect((await a.get(`/api/vehicles/${runB.vehicleId}/trace`)).status()).toBe(403);
    expect((await a.post("/api/agent/turn", { data: { vehicleId: runB.vehicleId, message: "¿Cuánto cuesta?" } })).status()).toBe(403);
    expect((await a.post("/api/bookings/confirm", { data: { confirmationToken: tokenB } })).status()).toBe(403);
    expect((await a.get("/api/cases")).status()).toBe(403);
    expect((await a.post("/api/cases/cualquiera/resolve", { data: { outcome: "CLOSE", resolution: "intento indebido" } })).status()).toBe(403);
    // Sigue viendo lo propio.
    expect((await a.get(`/api/vehicles/${runA.vehicleId}/overview`)).status()).toBe(200);

    const anon = await pwRequest.newContext({ baseURL: base });
    expect((await anon.get("/api/me")).status()).toBe(401);
    expect((await anon.get(`/api/vehicles/${runA.vehicleId}/overview`)).status()).toBe(401);
    expect((await anon.post("/api/bookings/confirm", { data: { confirmationToken: tokenB } })).status()).toBe(401);
    // Personas no demo (o inexistentes) no se pueden suplantar.
    expect((await anon.post("/api/demo/session", { data: { actorId: "no-existe" } })).status()).toBe(404);
    await Promise.all([a.dispose(), b.dispose(), anon.dispose()]);
  });

  test("el asesor no puede usar el asistente ni resolver un caso ajeno @api", async () => {
    const ctx = await pwRequest.newContext({ baseURL: base });
    const run = await apiRun(ctx, "A");
    expect((await ctx.post("/api/demo/session", { data: { actorId: run.advisorActorId } })).status()).toBe(200);
    expect((await ctx.post("/api/agent/turn", { data: { vehicleId: run.vehicleId, message: "hola" } })).status()).toBe(403);
    // Caso inexistente o ajeno: 403 indistinto (no revela si el caso existe).
    expect((await ctx.post("/api/cases/no-existe/resolve", { data: { outcome: "CLOSE", resolution: "sin caso real" } })).status()).toBe(403);
    await ctx.dispose();
  });

  test("aislamiento entre visitantes: no se puede entrar como personas de otra corrida ni del seed @api", async () => {
    const a = await pwRequest.newContext({ baseURL: base });
    const b = await pwRequest.newContext({ baseURL: base });
    const runA = await apiRun(a, "C");
    await apiTurn(a, runA.vehicleId, "El freno se hunde y casi no detiene el carro");
    await apiRun(b, "A");
    for (const actorId of [runA.advisorActorId, runA.ownerActorId, "act-advisor", "act-owner-c1"]) {
      expect((await b.post("/api/demo/session", { data: { actorId } })).status(), actorId).toBe(404);
    }
    // El asesor de A ve su caso; nadie más lo ve.
    expect((await a.post("/api/demo/session", { data: { actorId: runA.advisorActorId } })).status()).toBe(200);
    const cases = (await (await a.get("/api/cases")).json()) as { cases: Array<{ vehicle: { vehicleId: string } }> };
    expect(cases.cases.map((k) => k.vehicle.vehicleId)).toEqual([runA.vehicleId]);
    await Promise.all([a.dispose(), b.dispose()]);
  });

  test("entradas inválidas se rechazan con errores estables @api", async () => {
    const ctx = await pwRequest.newContext({ baseURL: base });
    const run = await apiRun(ctx, "A");
    expect((await ctx.post("/api/demo/scenarios", { data: { scenario: "Z" } })).status()).toBe(400);
    expect((await ctx.post("/api/agent/turn", { headers: { "content-type": "text/plain" }, data: "hola" })).status()).toBe(415);
    expect((await ctx.post("/api/agent/turn", { headers: { "content-type": "application/json" }, data: "{no json" })).status()).toBe(400);
    expect((await ctx.post("/api/agent/turn", { data: { vehicleId: run.vehicleId, message: "x".repeat(9000) } })).status()).toBe(413);
    expect((await ctx.post("/api/agent/turn", { data: { vehicleId: run.vehicleId, message: "hola", extra: 1 } })).status()).toBe(400);
    expect((await ctx.post("/api/bookings/confirm", { data: { confirmationToken: "x".repeat(40) } })).status()).toBe(404);
    expect((await ctx.get(`/api/vehicles/${run.vehicleId}/overview?serviceCode=SOAT`)).status()).toBe(400);
    const t = await apiTurn(ctx, run.vehicleId, "¿Qué mantenimiento le toca a mi carro?");
    expect(JSON.stringify(t)).not.toMatch(/\bVIN\b|vin":/);
    await ctx.dispose();
  });

  test("UI: vehículo ajeno muestra acceso denegado", async ({ page }) => {
    const other = await pwRequest.newContext({ baseURL: base });
    const runOther = await apiRun(other, "A");
    await startScenario(page, "A");
    await page.goto(`/vehiculo/${runOther.vehicleId}`);
    await expect(page.getByRole("alert").filter({ hasText: "No tienes acceso a este vehículo" })).toBeVisible();
    await other.dispose();
  });

  test("UI: falla del asistente muestra recuperación y reintento", async ({ page }) => {
    await startScenario(page, "A");
    await openAssistant(page);
    let fail = true;
    await page.route("**/api/agent/turn", (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL" }, traceId: "t" }) }) : route.continue()));
    await page.getByLabel("Mensaje para el asistente").fill("¿Qué mantenimiento le toca a mi carro?");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("El asistente no pudo responder. Tu información no cambió.")).toBeVisible();
    fail = false;
    await page.getByTestId("retry-turn").click();
    await expect(page.getByRole("heading", { name: /Evaluación: Cambio de aceite/ })).toBeVisible();
  });

  test("UI: sesión ausente pide iniciar un escenario", async ({ page }) => {
    await page.goto("/casos");
    await expect(page.getByRole("heading", { name: "Necesitas una sesión" })).toBeVisible();
  });

  test("UI: segundo clic en confirmar no duplica (botón bloqueado y backend idempotente)", async ({ page }) => {
    await startScenario(page, "A");
    await openAssistant(page);
    for (const m of ["¿Qué mantenimiento le toca a mi carro?", "¿Cuánto cuesta?", "¿Qué horarios hay?", "Reserva el primer horario"]) await say(page, m);
    const btn = page.getByTestId("confirm-booking");
    await btn.dblclick();
    await expect(page.getByText(/Reserva confirmada por el taller/)).toHaveCount(1);
    await expect(page.getByTestId("confirm-booking")).toHaveCount(0);
  });
});
