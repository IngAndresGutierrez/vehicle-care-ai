/**
 * Límite de tasa por clave con ventana deslizante en memoria. Suficiente para un único proceso (demo);
 * en serverless o con varias instancias debe sustituirse por un almacén compartido (riesgo documentado).
 */
export interface RateLimiter {
  check(key: string, now: Date): { allowed: boolean; retryAfterSeconds: number };
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now: Date): { allowed: boolean; retryAfterSeconds: number } {
    const t = now.getTime();
    const recent = (this.hits.get(key) ?? []).filter((h) => h > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
