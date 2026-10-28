import "dotenv/config";
import { createPrismaClient, type Db } from "@/infra/prisma";
import { seedDemoData } from "@/infra/seed/demo-seed";

/** Nombre de la base apuntada por una URL de PostgreSQL. */
export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/**
 * URL de la base de integración. Se niega a operar sobre cualquier base que no termine en `_test`
 * para que un error de configuración nunca trunque la base de desarrollo.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST no está definida (ver .env.example)");
  if (!databaseName(url).endsWith("_test")) {
    throw new Error(`DATABASE_URL_TEST debe apuntar a una base *_test; recibido "${databaseName(url)}"`);
  }
  return url;
}

export function connectTestDb(): Db {
  return createPrismaClient(testDatabaseUrl());
}

/**
 * Vacía todas las tablas de la aplicación y vuelve a sembrar.
 * TRUNCATE no dispara los triggers de fila append-only (ver migración de invariantes).
 */
export async function resetAndSeed(db: Db): Promise<void> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  await seedDemoData(db);
}
