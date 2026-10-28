import { createHash, randomBytes } from "node:crypto";

/**
 * Token de confirmación de reserva (ADR-017): 256 bits aleatorios en base64url. Se entrega una sola vez al
 * solicitante; en la base solo se guarda su sha256. Nunca debe aparecer en logs, trazas ni AuditLog.
 */
export function generateConfirmationToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
