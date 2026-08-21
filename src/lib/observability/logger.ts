type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

export type LogFields = Record<string, unknown>;

/**
 * Deliberately dependency-free structured logging: one JSON object per line on
 * stdout. That is exactly what CloudWatch / Cloud Logging / Loki want, and it
 * avoids adding pino + transports for what amounts to twenty lines of code.
 *
 * `bind` produces a child logger so a request id and repo id flow through the
 * whole call stack without being threaded manually into every function.
 */
export class Logger {
  constructor(private readonly base: LogFields = {}) {}

  bind(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields });
  }

  private emit(level: Level, message: string, fields?: LogFields) {
    if (LEVEL_ORDER[level] < threshold()) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...this.base,
      ...fields,
    });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }

  debug = (m: string, f?: LogFields) => this.emit("debug", m, f);
  info = (m: string, f?: LogFields) => this.emit("info", m, f);
  warn = (m: string, f?: LogFields) => this.emit("warn", m, f);

  error = (m: string, error?: unknown, f?: LogFields) =>
    this.emit("error", m, {
      ...f,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
    });

  /** Times an async span and logs its duration, success or failure. */
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.debug(`${name} ok`, { durationMs: Math.round(performance.now() - start) });
      return result;
    } catch (error) {
      this.error(`${name} failed`, error, {
        durationMs: Math.round(performance.now() - start),
      });
      throw error;
    }
  }
}

export const logger = new Logger({ service: "code-docs-assistant" });
