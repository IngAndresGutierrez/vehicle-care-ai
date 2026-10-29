import { defineConfig, devices } from "@playwright/test";

/**
 * E2E de la demo (Fase 6). Corre contra `next start` con la base de desarrollo ya migrada y sembrada
 * (`pnpm db:migrate:deploy && pnpm db:seed`). Cada escenario crea una corrida aislada; no se borra nada.
 * Siempre con ScriptedLlm: estas pruebas NO prueban un LLM real.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
/** Con E2E_BASE_URL las pruebas corren contra un despliegue existente (p. ej. Vercel) y no se levanta servidor local. */
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
/** Modo controlado con Claude real (Fase 8C): solo con E2E_REAL_LLM=1 y presupuesto aprobado. Corre únicamente los tests @real. */
const REAL = process.env.E2E_REAL_LLM === "1";
if (REAL) process.env.E2E_ALLOW_REAL_LLM = "1";

export default defineConfig({
  testDir: "tests/e2e",
  // Corre después de que el servidor está arriba: verifica que el LLM sea ScriptedLlm (sin costo).
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: REAL ? 300_000 : 60_000,
  expect: { timeout: 10_000 },
  // Secuencial: las corridas son aisladas, pero comparten el calendario simulado del taller (cupo 3 por horario);
  // en paralelo, varias reservas del «primer horario» chocarían de verdad (SLOT_CONFLICT) y el resultado no sería determinista.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "prd/reports/playwright" }]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure", locale: "es-CO", timezoneId: "America/Bogota" },
  // Sin E2E_REAL_LLM, los tests @real nunca se ejecutan; con él, solo esos.
  ...(REAL ? { grep: /@real/ } : { grepInvert: /@real/ }),
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // Las pruebas solo de API (@api) no dependen del viewport: basta con escritorio.
    // El filtro del proyecto reemplaza al global: se repite @real aquí. En modo real solo corre escritorio.
    { name: "mobile", use: { ...devices["Pixel 7"] }, grepInvert: REAL ? /.*/ : /@api|@real/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm start --port ${PORT}`,
        url: `http://localhost:${PORT}/api/demo/config`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { DEMO_MODE: "true", LLM_PROVIDER: REAL ? "anthropic" : "scripted", LLM_MODEL: "claude-sonnet-5-5", DEMO_RUNS_PER_10_MIN: "500", AGENT_TURNS_PER_MINUTE: "200", BOOKING_CONFIRMS_PER_MINUTE: "100" },
      },
});
