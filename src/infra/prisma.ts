import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

export type Db = PrismaClient;

/** Cliente Prisma 7 con el adaptador `pg`. Quien lo crea es responsable de `$disconnect()`. */
export function createPrismaClient(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as { vehicleCarePrisma?: Db };

/** Instancia compartida para la app (evita múltiples pools con el recargado en caliente de Next.js). */
export function getPrisma(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no está definida");
  globalForPrisma.vehicleCarePrisma ??= createPrismaClient(url);
  return globalForPrisma.vehicleCarePrisma;
}
