import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Variables a provider process may inherit. Everything else, credentials
 * included (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_CONFIG_DIR, CODEX_HOME...),
 * is left out, so the selected account cannot be overridden by the
 * environment the application happened to start in.
 */
const INHERITED = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
    // Linux keyrings and desktop sessions.
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    // Corporate networks.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    // Windows essentials.
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "HOMEDRIVE",
    "HOMEPATH",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
  ].map((name) => name.toUpperCase()),
);

const inherited = (name: string) => INHERITED.has(name.toUpperCase()) || /^LC_[A-Z]+$/.test(name);

/** Where user-level CLIs are commonly installed but GUI-launched apps often lack on PATH. */
export function commonBinDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32") {
    return [
      env.APPDATA ? join(env.APPDATA, "npm") : "",
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : "",
      join(home, ".bun", "bin"),
      join(home, ".local", "bin"),
    ].filter(Boolean);
  }
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".cargo", "bin"),
    "/usr/bin",
    "/bin",
  ];
}

export interface BuildEnvOptions {
  base?: NodeJS.ProcessEnv;
  /** Provider-specific variables, applied last. `undefined` removes a variable. */
  set?: Record<string, string | undefined>;
  /** Directories appended to PATH when absent (e.g. the executable's own directory). */
  extraPath?: string[];
  platform?: NodeJS.Platform;
}

/** An explicit environment for a provider process. */
export function buildEnv(options: BuildEnvOptions = {}): Record<string, string> {
  const base = options.base ?? process.env;
  const platform = options.platform ?? process.platform;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && inherited(name)) env[name] = value;

  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = platform === "win32" ? ";" : delimiter;
  const entries = (env[pathKey] ?? "").split(sep).filter(Boolean);
  for (const dir of [...(options.extraPath ?? []), ...commonBinDirs(platform, base)]) if (!entries.includes(dir)) entries.push(dir);
  env[pathKey] = entries.join(sep);

  for (const [name, value] of Object.entries(options.set ?? {})) {
    // Windows names are case-insensitive: replace any existing spelling.
    if (platform === "win32") for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}
