import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    // evals aún no tiene tests (Fase 7).
    passWithNoTests: true,
    projects: [
      {
        resolve: { alias },
        test: {
          // Unitarios: sin I/O ni base de datos.
          name: "unit",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.ts"],
          // Reloj y zona del proceso no deben influir: el dominio recibe `now` y usa America/Bogota explícitamente.
          env: { TZ: "UTC" },
        },
      },
      {
        resolve: { alias },
        test: {
          // Integración: PostgreSQL real (vehicle_care_test). Secuencial: comparten la base.
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/integration/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
          env: { TZ: "UTC" },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "evals",
          environment: "node",
          include: ["tests/evals/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts"],
      exclude: ["src/domain/**/__tests__/**", "src/domain/**/__fixtures__/**"],
    },
  },
});
