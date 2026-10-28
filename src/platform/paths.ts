import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The per-OS-user EDUKORS data directory, shared by every EDUKORS application
 * on this computer. Resolved by platform convention; `EDUKORS_AI_DATA_DIR`
 * overrides it (tests, portable installs).
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.EDUKORS_AI_DATA_DIR;
  if (override) return resolve(override);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "EDUKORS");
  // Local, not roaming: account directories hold machine-bound provider state.
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "EDUKORS");
  return join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share"), "edukors");
}

/** Stable, filesystem-safe key for an arbitrary document identifier. */
export const documentKey = (documentId: string): string => createHash("sha256").update(documentId).digest("hex").slice(0, 24);

export class DataPaths {
  readonly root: string;

  /** Always absolute: provider processes run in other working directories. */
  constructor(root: string) {
    this.root = resolve(root);
  }

  get registryFile(): string {
    return join(this.root, "ai", "registry.json");
  }

  get locksDir(): string {
    return join(this.root, "ai", "locks");
  }

  /** Stored relative to the root in the registry, so the root may move. */
  accountHomeRelative(accountId: string): string {
    return join("ai", "accounts", accountId);
  }

  resolve(relative: string): string {
    return join(this.root, relative);
  }

  sessionDir(appId: string, documentId: string, accountId: string): string {
    return join(this.root, "ai", "sessions", appId, documentKey(documentId), accountId);
  }
}
