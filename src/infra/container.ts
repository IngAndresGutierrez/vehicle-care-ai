import { MaintenanceAdvisor } from "@/agent/maintenance-advisor";
import { AnthropicLlm } from "@/agent/llm/anthropic-llm";
import { ScriptedLlm } from "@/agent/llm/scripted-llm";
import type { LlmPort } from "@/agent/llm/types";
import type { BookingDeps } from "@/application/booking/common";
import { MockCrmAdapter } from "@/integrations/mock/mock-crm-adapter";
import { MockWorkshopAdapter } from "@/integrations/mock/mock-workshop-adapter";
import { MockWorkshopSystem } from "@/integrations/mock/mock-workshop-system";
import { systemClock, type Clock } from "./clock";
import { getPrisma, type Db } from "./prisma";
import { SlidingWindowRateLimiter, type RateLimiter } from "./rate-limit";

/** Raíz de composición (ARCHITECTURE.md §3): el único lugar que instancia adaptadores y elige el LLM. */
export interface Container {
  db: Db;
  clock: Clock;
  booking: BookingDeps;
  advisor: MaintenanceAdvisor;
  llm: LlmPort;
  turnLimiter: RateLimiter;
  confirmLimiter: RateLimiter;
  /** Inicio de corridas demo por IP (evita abuso de la base en DEMO_MODE). */
  demoLimiter: RateLimiter;
  /** Tope global de corridas demo en 24 h (contado en la base: vale entre instancias serverless). */
  demoRunsPerDay: number;
  /** Solo local: permite entrar como las personas fijas del seed (act-*). En una demo pública queda en false. */
  demoSeedPersonas: boolean;
  sessionSecret: string;
  demoMode: boolean;
}

type Env = Record<string, string | undefined>;

export function buildLlm(env: Env): LlmPort {
  const provider = (env.LLM_PROVIDER ?? "scripted").toLowerCase();
  if (provider === "scripted") return new ScriptedLlm();
  if (provider !== "anthropic") throw new Error(`LLM_PROVIDER desconocido: ${provider}`);
  const effort = (env.LLM_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
  return new AnthropicLlm({
    model: env.LLM_MODEL ?? "claude-opus-5-5",
    effort,
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 30_000),
    maxRetries: Number(env.LLM_MAX_RETRIES ?? 2),
    serverFallbacks: env.LLM_SERVER_FALLBACKS !== "false",
  });
}

export function buildContainer(env: Env = process.env, overrides: Partial<Pick<Container, "db" | "clock" | "llm">> = {}): Container {
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET debe tener al menos 32 caracteres (ver .env.example)");
  const db = overrides.db ?? getPrisma();
  const clock = overrides.clock ?? systemClock;
  const llm = overrides.llm ?? buildLlm(env);
  // Taller y CRM: siempre MOCK en el MVP (ADR-017).
  const booking: BookingDeps = { db, clock, workshop: new MockWorkshopAdapter(new MockWorkshopSystem(db, clock)), crm: new MockCrmAdapter(db) };
  const advisor = new MaintenanceAdvisor({
    ...booking,
    llm,
    hashSecret: env.LOG_HASH_SECRET ?? sessionSecret,
    limits: {
      maxIterations: Number(env.AGENT_MAX_ITERATIONS ?? 6),
      maxOutputTokensPerTurn: Number(env.AGENT_MAX_OUTPUT_TOKENS_PER_TURN ?? 16_000),
      turnTimeoutMs: Number(env.AGENT_TURN_TIMEOUT_MS ?? 45_000),
    },
  });
  return {
    db,
    clock,
    booking,
    advisor,
    llm,
    turnLimiter: new SlidingWindowRateLimiter(Number(env.AGENT_TURNS_PER_MINUTE ?? 20), 60_000),
    confirmLimiter: new SlidingWindowRateLimiter(Number(env.BOOKING_CONFIRMS_PER_MINUTE ?? 10), 60_000),
    demoLimiter: new SlidingWindowRateLimiter(Number(env.DEMO_RUNS_PER_10_MIN ?? 12), 10 * 60_000),
    demoRunsPerDay: Number(env.DEMO_RUNS_PER_DAY ?? 500),
    demoSeedPersonas: env.DEMO_SEED_PERSONAS === "true",
    sessionSecret,
    demoMode: env.DEMO_MODE === "true",
  };
}

const globalForContainer = globalThis as unknown as { vehicleCareContainer?: Container };

export function getContainer(): Container {
  globalForContainer.vehicleCareContainer ??= buildContainer();
  return globalForContainer.vehicleCareContainer;
}

/** Solo tests: inyecta un contenedor (base de pruebas, reloj fijo, LLM simulado). */
export function setContainerForTests(container: Container | undefined): void {
  globalForContainer.vehicleCareContainer = container;
}
