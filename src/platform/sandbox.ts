import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * The macOS system sandbox (Seatbelt, through `sandbox-exec`) around a
 * provider process that works in a workspace: it reads only the folders
 * named here and the system's, writes only the writable ones, and never the
 * protected paths. Everything the process starts inherits it, commands
 * included.
 *
 * A process inside it cannot apply a sandbox of its own (`sandbox_apply:
 * Operation not permitted`), so the provider must be told that its commands
 * already run in an external sandbox.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface SandboxPaths {
  /** Read and written: the workspace, the account's home, the session's scratch space. */
  writable: string[];
  /** Read only: the workspace's extra folders, the provider's and Node's installation. */
  readable: string[];
  /** Never written, though inside a writable folder. */
  protectedPaths: string[];
}

/** What the system and a CLI installed the usual ways need to read to start. */
export function runtimeDirs(executable: string, realExecutable: string): string[] {
  return [
    dirname(executable),
    dirname(realExecutable),
    // An npm-installed CLI is a Node script; Node and its version managers.
    dirname(process.execPath),
    ...userToolDirs(),
  ];
}

/** Where the usual version managers keep the tools a command may run (Node, Bun, Python). */
export function userToolDirs(): string[] {
  const home = homedir();
  return [join(home, ".nvm"), join(home, ".bun"), join(home, ".local", "share", "mise"), join(home, ".local", "share", "uv"), join(home, ".local", "bin")];
}

/** What a command needs to read on macOS besides its workspace: the system and installed tools, not users' or temporary files. */
export const MACOS_SYSTEM_READABLE = ["/System", "/Library", "/usr", "/bin", "/sbin", "/opt", "/dev", "/private/etc", "/private/var/db", "/private/var/run"];

export function seatbeltPolicy(paths: SandboxPaths): string {
  const subpath = (p: string) => `(subpath ${JSON.stringify(p)})`;
  const literal = (p: string) => `(literal ${JSON.stringify(p)})`;
  const outside = (dirs: string[]) => dirs.map((p) => `(require-not ${subpath(p)})`).join(" ");
  const readable = [...paths.writable, ...paths.readable, ...MACOS_SYSTEM_READABLE];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny appleevent-send)",
    // Listing "/" itself (names only) stays readable: without it Node aborts at startup.
    `(deny file-read-data (require-all ${outside(readable)} (require-not ${literal("/")})))`,
    `(deny file-write* (require-all ${outside(paths.writable)} (require-not ${literal("/dev/null")}) (require-not ${literal("/dev/tty")})))`,
  ];
  if (paths.protectedPaths.length) lines.push(`(deny file-write* ${paths.protectedPaths.map(subpath).join(" ")})`);
  return lines.join("\n");
}

/** The command line that runs `file args` inside the sandbox. */
export function sandboxed(file: string, args: string[], paths: SandboxPaths): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ["-p", seatbeltPolicy(paths), file, ...args] };
}
