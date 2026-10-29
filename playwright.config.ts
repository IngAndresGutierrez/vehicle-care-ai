import { defineConfig, devices } from "@playwright/test";

/**
 * E2E de la demo (Fase 6). Corre contra `next start` con la base de desarrollo ya migrada y sembrada
 * (`pnpm db:migrate:deploy && pnpm db:seed`). Cada escenario crea una corrida aislada; no se borra nada.
 * Siempre con ScriptedLlm: estas pruebas NO prueban un LLM real.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Secuencial: las corridas son aisladas, pero comparten el calendario simulado del taller (cupo 3 por horario);
  // en paralelo, varias reservas del «primer horario» chocarían de verdad (SLOT_CONFLICT) y el resultado no sería determinista.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "prd/reports/playwright" }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", locale: "es-CO", timezoneId: "America/Bogota" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // Las pruebas solo de API (@api) no dependen del viewport: basta con escritorio.
    { name: "mobile", use: { ...devices["Pixel 7"] }, grepInvert: /@api/ },
  ],
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: `http://localhost:${PORT}/api/demo/config`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { DEMO_MODE: "true", LLM_PROVIDER: "scripted", DEMO_RUNS_PER_10_MIN: "500", AGENT_TURNS_PER_MINUTE: "200", BOOKING_CONFIRMS_PER_MINUTE: "100" },
  },
});
