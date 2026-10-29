import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sesión firmada (HMAC-SHA256) para la demo (D-11). Contiene solo el actorId y la expiración: los permisos se
 * resuelven en el servidor en cada solicitud. Sustituible por OTP/SSO real detrás de la misma interfaz.
 */
export const SESSION_COOKIE = "vc_session";

export interface SessionClaims {
  actorId: string;
  /** Epoch en segundos. */
  exp: number;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function signSession(claims: SessionClaims, secret: string): string {
  if (secret.length < 32) throw new Error("SESSION_SECRET debe tener al menos 32 caracteres");
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | null | undefined, secret: string, now: Date): SessionClaims | null {
  if (!token || token.length > 1024) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
    if (typeof claims.actorId !== "string" || typeof claims.exp !== "number") return null;
    return claims.exp * 1000 > now.getTime() ? claims : null;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Corridas de demo iniciadas desde este navegador (D-11, ADR-020): solo a sus personas se puede cambiar. */
export const DEMO_RUNS_COOKIE = "vc_demo_runs";
const RUN_ID = /^[0-9a-f]{8}$/;

export function signDemoRuns(runIds: readonly string[], exp: number, secret: string): string {
  const payload = b64(JSON.stringify({ runs: runIds.filter((r) => RUN_ID.test(r)).slice(0, 8), exp }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyDemoRuns(token: string | null | undefined, secret: string, now: Date): string[] {
  if (!token || token.length > 1024) return [];
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return [];
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return [];
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { runs?: unknown; exp?: unknown };
    if (!Array.isArray(claims.runs) || typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) return [];
    return claims.runs.filter((r): r is string => typeof r === "string" && RUN_ID.test(r));
  } catch {
    return [];
  }
}
