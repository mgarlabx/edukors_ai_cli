import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { AiCliError } from "./errors.js";
import type { Capabilities, Workspace } from "./provider.js";

/**
 * A folder the agent works in with the provider's own file, web and (where
 * a sandbox confines them) command tools: the application's document folder,
 * for an editor whose documents are folders of files.
 */
export interface WorkspaceOptions {
  /** Absolute path of an existing folder: the agent's working directory. */
  dir: string;
  /** Absolute paths of existing folders the agent may read, such as copies of attachments. */
  readDirs?: string[];
  /** Paths relative to `dir` the agent may read but not write: the application's own files. */
  protect?: string[];
  /** Web search and fetch. Default true. */
  web?: boolean;
  /** Commands, confined to the workspace. Default true; never where the provider has no sandbox (`workspaceShell`). */
  shell?: boolean;
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

async function folder(path: string, what: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new AiCliError("INVALID_ARGUMENT", `${what} must be an absolute path`);
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new AiCliError("INVALID_ARGUMENT", `${what} must be an existing folder`);
  }
  // A workspace this broad would confine nothing.
  if (real === parse(real).root || real === (await realpath(homedir()).catch(() => homedir()))) throw new AiCliError("INVALID_ARGUMENT", `${what} cannot be the home folder or a drive's root`);
  return real;
}

/** Checks the application's request and settles what the session gets, given the provider's capabilities. */
export async function resolveWorkspace(options: WorkspaceOptions, capabilities: Capabilities, reserved: string[]): Promise<Workspace> {
  const dir = await folder(options.dir, "workspace.dir");
  // The library's own folders (accounts, sessions) must stay out of reach.
  for (const own of reserved) if (inside(own, dir) || inside(dir, own)) throw new AiCliError("INVALID_ARGUMENT", "workspace.dir overlaps the library's data folder");
  const readDirs = await Promise.all((options.readDirs ?? []).map((p, i) => folder(p, `workspace.readDirs[${i}]`)));
  const protectedPaths = (options.protect ?? []).map((p) => {
    const rel = typeof p === "string" ? normalize(p).replace(/[\\/]+$/, "") : "";
    if (!rel || rel === "." || isAbsolute(rel) || rel.split(sep).includes("..")) throw new AiCliError("INVALID_ARGUMENT", `workspace.protect entries must be paths inside the workspace: ${String(p)}`);
    return join(dir, rel);
  });
  return { dir, readDirs, protectedPaths, web: options.web ?? true, shell: (options.shell ?? true) && capabilities.workspaceShell };
}
