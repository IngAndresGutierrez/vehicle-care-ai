import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./helpers/test-db";

/** Aplica las migraciones pendientes a vehicle_care_test antes de la suite (no destructivo). */
export default function setup(): void {
  testDatabaseUrl(); // valida que el destino sea una base *_test
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, PRISMA_TARGET: "test" },
    stdio: "inherit",
  });
}
