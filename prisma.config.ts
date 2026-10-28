import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// PRISMA_TARGET=test dirige la CLI a la base de integración (vehicle_care_test), nunca a la de desarrollo.
const isTestTarget = process.env.PRISMA_TARGET === "test";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: isTestTarget ? env("DATABASE_URL_TEST") : env("DATABASE_URL"),
  },
});
