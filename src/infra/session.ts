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
