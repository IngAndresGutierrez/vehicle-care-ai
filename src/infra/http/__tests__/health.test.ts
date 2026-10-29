import { afterEach, describe, expect, it, vi } from "vitest";
import { handleHealth } from "../health";

describe("handleHealth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("200 con la base disponible", async () => {
    const res = await handleHealth(() => ({ $queryRaw: async () => [{ "?column?": 1 }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  it("503 sin filtrar el mensaje de error de la conexión", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleHealth(() => ({
      $queryRaw: async () => {
        throw new Error("connect ECONNREFUSED postgres.railway.internal:5432 user=postgres");
      },
    }));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ status: "error", database: "error" });
    expect(body).not.toMatch(/railway|postgres|ECONN/);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/railway\.internal|user=/);
  });

  it("503 si la base no responde a tiempo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleHealth(() => ({ $queryRaw: () => new Promise(() => {}) }), 20);
    expect(res.status).toBe(503);
  });

  it("503 si falta DATABASE_URL (getPrisma lanza)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleHealth(() => {
      throw new Error("DATABASE_URL no está definida");
    });
    expect(res.status).toBe(503);
  });
});
