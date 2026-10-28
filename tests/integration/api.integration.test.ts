import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ScriptedLlm } from "@/agent/llm/scripted-llm";
import { DEMO_NOW } from "@/domain/maintenance-engine/__fixtures__/synthetic-demo";
import { fixedClock } from "@/infra/clock";
import { buildContainer, type Container } from "@/infra/container";
import { handleAgentTurn, handleBookingConfirm, handleDemoSession } from "@/infra/http/handlers";
import { DEMO_IDS } from "@/infra/seed/demo-seed";
import { SESSION_COOKIE, signSession } from "@/infra/session";
import { runJob } from "./helpers/agent";
import { connectTestDb, resetAndSeed } from "./helpers/test-db";

const db = connectTestDb();
const SECRET = "api-test-session-secret-0123456789abcdef";
const { vehicles: V, actors: A } = DEMO_IDS;

const container = (env: Record<string, string> = {}): Container =>
  buildContainer({ SESSION_SECRET: SECRET, LOG_HASH_SECRET: SECRET, AGENT_TURNS_PER_MINUTE: "50", DEMO_MODE: "true", ...env }, { db, clock: fixedClock(DEMO_NOW.toISOString()), llm: new ScriptedLlm() });

const cookieFor = (actorId: string) => `${SESSION_COOKIE}=${signSession({ actorId, exp: Math.floor(DEMO_NOW.getTime() / 1000) + 3600 }, SECRET)}`;
const post = (url: string, body: unknown, cookie?: string, contentType = "application/json") =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": contentType, ...(cookie ? { cookie } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(async () => {
  await resetAndSeed(db);
  await runJob(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe("POST /api/agent/turn", () => {
  it("responde con texto, tarjetas, estado del journey, traza segura y errores recuperables", async () => {
    const c = container();
    const res = await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "¿Qué mantenimiento le toca a mi carro?" }, cookieFor(A.ownerC1)), c);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-trace-id")).toMatch(/^trc_/);
    const body = await res.json();
    expect(body).toMatchObject({
      sessionId: expect.any(String),
      assistant: { text: expect.stringContaining("800 km"), kind: "ASSISTANT", simulated: true, model: expect.stringContaining("simulación") },
      cards: [expect.objectContaining({ type: "EVALUATION", status: "UPCOMING" })],
      journey: { state: "RECOMMENDATION_PRESENTED", allowedTools: expect.arrayContaining(["getQuote"]) },
      trace: { toolCalls: [expect.objectContaining({ tool: "evaluateMaintenance", ok: true, summary: expect.stringContaining("status=UPCOMING") })], llm: { provider: "SCRIPTED" }, guard: { blocked: false } },
      errors: [],
    });
    expect(JSON.stringify(body)).not.toMatch(/DMO001|c1@demo\.invalid|Cliente Demo|vehicleIdHash/);
  });

  it("401 sin sesión o con cookie manipulada; 403 si no es propietario", async () => {
    const c = container();
    expect((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola" }), c)).status).toBe(401);
    const forged = `${SESSION_COOKIE}=${signSession({ actorId: A.ownerC1, exp: 9_999_999_999 }, "otra-clave-0123456789abcdefghijklmnop")}`;
    expect((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola" }, forged), c)).status).toBe(401);
    expect((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola" }, cookieFor(A.advisor)), c)).status).toBe(403);
  });

  it("acceso cruzado: un propietario no puede conversar sobre un vehículo ajeno", async () => {
    const res = await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola" }, cookieFor(A.ownerC2)), container());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("valida estrictamente el cuerpo: campos extra (actorId, traceId), JSON inválido, tipo y tamaño", async () => {
    const c = container();
    const cookie = cookieFor(A.ownerC1);
    expect((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola", actorId: A.ownerC2 }, cookie), c)).status).toBe(400);
    expect((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola", traceId: "mio" }, cookie), c)).status).toBe(400);
    expect((await handleAgentTurn(post("/api/agent/turn", "{no json", cookie), c)).status).toBe(400);
    expect((await handleAgentTurn(post("/api/agent/turn", "hola", cookie, "text/plain"), c)).status).toBe(415);
    expect((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "x".repeat(9000) }, cookie), c)).status).toBe(413);
  });

  it("429 al superar el límite de turnos por minuto, con Retry-After", async () => {
    const c = container({ AGENT_TURNS_PER_MINUTE: "2" });
    const cookie = cookieFor(A.ownerC1);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola" }, cookie), c)).status);
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message: "hola" }, cookie), c);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("POST /api/bookings/confirm (clic humano, fuera del LLM)", () => {
  it("el propietario confirma con el token de la tarjeta; otro cliente no puede", async () => {
    const c = container();
    const cookie = cookieFor(A.ownerC1);
    let sessionId: string | undefined;
    let token = "";
    for (const message of ["¿Qué mantenimiento le toca a mi carro?", "¿Cuánto cuesta?", "¿Qué horarios hay?", "Reserva el primer horario"]) {
      const body = await (await handleAgentTurn(post("/api/agent/turn", { vehicleId: V.v1, message, ...(sessionId ? { sessionId } : {}) }, cookie), c)).json();
      sessionId = body.sessionId;
      token = body.cards.find((x: { type: string }) => x.type === "BOOKING_INTENT")?.confirmationToken ?? token;
    }
    expect(token.length).toBeGreaterThan(20);

    const stranger = await handleBookingConfirm(post("/api/bookings/confirm", { confirmationToken: token }, cookieFor(A.ownerC2)), c);
    expect(stranger.status).toBe(403);
    const ok = await handleBookingConfirm(post("/api/bookings/confirm", { confirmationToken: token }, cookie), c);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ booking: { status: "CONFIRMED", folio: expect.stringMatching(/^FOLIO-/), source: "MOCK" } });
    const again = await handleBookingConfirm(post("/api/bookings/confirm", { confirmationToken: token }, cookie), c);
    expect(await again.json()).toMatchObject({ booking: { duplicate: true } });
    expect((await handleBookingConfirm(post("/api/bookings/confirm", { confirmationToken: "x".repeat(43) }, cookie), c)).status).toBe(404);
  });
});

describe("POST /api/demo/session", () => {
  it("emite una cookie firmada HttpOnly rotulada como sesión simulada solo con DEMO_MODE", async () => {
    const res = await handleDemoSession(post("/api/demo/session", { actorId: A.ownerC1 }), container());
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^vc_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800/);
    expect(await res.json()).toMatchObject({ role: "OWNER", label: "Sesión simulada (demo)" });
    expect((await handleDemoSession(post("/api/demo/session", { actorId: A.ownerC1 }), container({ DEMO_MODE: "false" }))).status).toBe(404);
    expect((await handleDemoSession(post("/api/demo/session", { actorId: "nadie" }), container())).status).toBe(404);
  });
});
