import "dotenv/config";
import { createPrismaClient } from "../src/infra/prisma";
import { seedDemoData } from "../src/infra/seed/demo-seed";

// Mismo criterio que prisma.config.ts: PRISMA_TARGET=test siembra la base de integración.
const url = process.env.PRISMA_TARGET === "test" ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;

async function main() {
  if (!url) throw new Error("Falta DATABASE_URL (o DATABASE_URL_TEST con PRISMA_TARGET=test)");
  const db = createPrismaClient(url);
  try {
    const { seeded } = await seedDemoData(db);
    console.log(seeded ? "Seed sintético aplicado." : "La base ya contiene el seed sintético; no se modificó.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
