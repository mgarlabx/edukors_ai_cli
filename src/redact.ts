import { homedir } from "node:os";

/** Keys whose values are never written to diagnostics. */
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|cookie|api[_-]?key|credential|session[_-]?key|private[_-]?key)/i;

const PATTERNS: [RegExp, string][] = [
  // Bearer and Basic authorization values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // Provider-style API keys (sk-..., sk-ant-..., ghp_..., xox?-...).
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "[redacted-key]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted-key]"],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]"],
  // key=value and "key": "value" forms with a sensitive key.
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi,
    "$1[redacted]",
  ],
  // Long opaque strings that look like credentials.
  [/\b[A-Za-z0-9+/_-]{64,}={0,2}/g, "[redacted-long]"],
];

export interface RedactOptions {
  /** Replaced with `~`. Defaults to the current OS user's home. */
  home?: string;
}

export function redactText(text: string, options: RedactOptions = {}): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  const home = options.home ?? homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  return out;
}

/** Deep copy with sensitive keys dropped and every string redacted. */
export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, options, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message, options) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(v, options, depth + 1);
    return out;
  }
  return value;
}
