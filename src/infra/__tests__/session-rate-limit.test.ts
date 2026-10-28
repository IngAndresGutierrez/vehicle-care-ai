import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "../rate-limit";
import { readCookie, signSession, verifySession } from "../session";

const SECRET = "x".repeat(40);
const NOW = new Date("2026-10-28T17:00:00Z");
const exp = Math.floor(NOW.getTime() / 1000) + 3600;

describe("sesión firmada", () => {
  it("verifica una sesión válida y rechaza manipulación, otra clave o expiración", () => {
    const token = signSession({ actorId: "act-owner-c1", exp }, SECRET);
    expect(verifySession(token, SECRET, NOW)).toEqual({ actorId: "act-owner-c1", exp });
    const [payload, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ actorId: "act-owner-c2", exp })).toString("base64url")}.${sig}`;
    expect(verifySession(forged, SECRET, NOW)).toBeNull();
    expect(verifySession(`${payload}.${sig}x`, SECRET, NOW)).toBeNull();
    expect(verifySession(token, "y".repeat(40), NOW)).toBeNull();
    expect(verifySession(token, SECRET, new Date((exp + 1) * 1000))).toBeNull();
    expect(verifySession(`${token}.extra`, SECRET, NOW)).toBeNull();
    expect(verifySession(null, SECRET, NOW)).toBeNull();
  });

  it("exige un secreto de al menos 32 caracteres y lee cookies", () => {
    expect(() => signSession({ actorId: "a", exp }, "corto")).toThrow();
    expect(readCookie("a=1; vc_session=abc%3D; b=2", "vc_session")).toBe("abc=");
    expect(readCookie(null, "vc_session")).toBeNull();
  });
});

describe("límite de tasa", () => {
  it("permite N solicitudes por ventana y reporta cuándo reintentar", () => {
    const limiter = new SlidingWindowRateLimiter(2, 60_000);
    expect(limiter.check("k", NOW).allowed).toBe(true);
    expect(limiter.check("k", NOW).allowed).toBe(true);
    expect(limiter.check("k", NOW)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check("otra", NOW).allowed).toBe(true);
    expect(limiter.check("k", new Date(NOW.getTime() + 60_001)).allowed).toBe(true);
  });
});
