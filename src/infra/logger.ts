type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Logger estructurado JSON (una línea por evento). Sin PII ni secretos: los llamadores pasan
 * identificadores pseudonimizados (ARCHITECTURE.md §8). Sustituible por pino si hace falta.
 */
export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...bindings, ...fields });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}
