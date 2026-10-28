/**
 * Verifica que las migraciones se aplican desde una base vacía y quedan alineadas con schema.prisma.
 *
 * Crea una base desechable con nombre único (vehicle_care_migcheck_<timestamp>), aplica `migrate deploy`,
 * comprueba con `migrate diff --exit-code` que no hay drift, ejecuta el seed y la elimina al final.
 * No toca vehicle_care ni vehicle_care_test.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { Client } from "pg";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL no está definida");

const dbName = `vehicle_care_migcheck_${Date.now()}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

function run(args: string[]): void {
  execFileSync("pnpm", ["exec", ...args], {
    env: { ...process.env, DATABASE_URL: targetUrl.toString(), PRISMA_TARGET: "" },
    stdio: "inherit",
  });
}

async function main() {
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`▶ Base limpia creada: ${dbName}`);
    run(["prisma", "migrate", "deploy"]);
    console.log("▶ Drift entre migraciones aplicadas y schema.prisma (debe estar vacío):");
    run(["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"]);
    console.log("▶ Seed sobre la base limpia:");
    run(["tsx", "prisma/seed.ts"]);
    console.log("✔ Migraciones reproducibles desde cero, sin drift y con seed aplicable.");
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    console.log(`▶ Base desechable eliminada: ${dbName}`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
