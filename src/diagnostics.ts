import { redactText, redactValue } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: unknown;
}

export type LogSink = (entry: DiagnosticEntry) => void;

/**
 * A bounded, redacted log. Everything recorded here is safe to export: the
 * redaction happens on the way in, so a forgotten call site cannot leak.
 */
export class Diagnostics {
  private readonly entries: DiagnosticEntry[] = [];

  constructor(
    private readonly capacity = 500,
    private readonly sink?: LogSink,
  ) {}

  log(level: LogLevel, scope: string, message: string, meta?: unknown): void {
    const entry: DiagnosticEntry = { at: new Date().toISOString(), level, scope, message: redactText(message) };
    if (meta !== undefined) entry.meta = redactValue(meta);
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.sink?.(entry);
  }

  scoped(scope: string): ScopedLog {
    return {
      debug: (message, meta) => this.log("debug", scope, message, meta),
      info: (message, meta) => this.log("info", scope, message, meta),
      warn: (message, meta) => this.log("warn", scope, message, meta),
      error: (message, meta) => this.log("error", scope, message, meta),
    };
  }

  snapshot(): DiagnosticEntry[] {
    return this.entries.slice();
  }
}

export interface ScopedLog {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
