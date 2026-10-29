import "dotenv/config";
import { defineConfig } from "prisma/config";

// PRISMA_TARGET=test dirige la CLI a la base de integración (vehicle_care_test), nunca a la de desarrollo.
const isTestTarget = process.env.PRISMA_TARGET === "test";
const url = isTestTarget ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Sin URL, `prisma generate` (postinstall en Vercel/CI) funciona igual; migrate y seed sí la exigen y fallan con un error claro.
  ...(url ? { datasource: { url } } : {}),
});
