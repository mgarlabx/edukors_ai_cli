import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildEnv, compareVersions, defaultDataDir, findExecutable, ManagedProcess, readLines, readVersion, redactText, redactValue, runCommand } from "../src/index.js";
import { tempDir } from "./helpers.js";

const posix = process.platform !== "win32";

describe("environment", () => {
  it("keeps only what a provider process needs", () => {
    const env = buildEnv({
      base: { PATH: "/usr/bin", HOME: "/home/u", LANG: "pt_BR.UTF-8", LC_ALL: "C", ANTHROPIC_API_KEY: "sk-x", OPENAI_API_KEY: "sk-y", CODEX_HOME: "/x", RANDOM: "1" },
      set: { CLAUDE_CONFIG_DIR: "/accounts/a", HOME: undefined },
      platform: "linux",
    });
    expect(env).toMatchObject({ LANG: "pt_BR.UTF-8", LC_ALL: "C", CLAUDE_CONFIG_DIR: "/accounts/a" });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("CODEX_HOME");
    expect(env).not.toHaveProperty("RANDOM");
    expect(env).not.toHaveProperty("HOME");
    expect(env.PATH!.split(":")[0]).toBe("/usr/bin");
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });

  it("resolves the shared data directory by platform", () => {
    expect(defaultDataDir({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/Library/Application Support/EDUKORS");
    expect(defaultDataDir({ HOME: "/home/u" }, "linux")).toBe("/home/u/.local/share/edukors");
    expect(defaultDataDir({ HOME: "/home/u", XDG_DATA_HOME: "/data" }, "linux")).toBe("/data/edukors");
    expect(defaultDataDir({ EDUKORS_AI_DATA_DIR: "/tmp/x" }, "darwin")).toBe("/tmp/x");
  });
});

describe.runIf(posix)("discovery", () => {
  it("finds an executable in a directory with spaces and non-ASCII characters, with a short PATH", async () => {
    const dir = join(await tempDir(), "Programas do usuário");
    await mkdir(dir);
    const exe = join(dir, "fake-tool");
    await writeFile(exe, "#!/bin/sh\necho 'fake-tool version 2.10.3'\n");
    await chmod(exe, 0o755);

    const found = await findExecutable({ names: ["fake-tool"], extraDirs: [dir], env: { PATH: "/usr/bin" }, loginShell: false });
    expect(found).toBe(exe);
    expect(await readVersion(exe)).toBe("2.10.3");
    expect(await findExecutable({ names: ["no-such-tool-xyz"], env: { PATH: "/usr/bin" }, loginShell: false })).toBeNull();
    expect(await findExecutable({ names: ["fake-tool"], override: exe })).toBe(exe);
    expect(await findExecutable({ names: ["fake-tool"], override: join(dir, "missing") })).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0")).toBe(0);
    expect(compareVersions("0.9.1", "1.0.0")).toBe(-1);
  });
});

describe.runIf(posix)("processes", () => {
  it("terminates the whole process tree", async () => {
    const proc = new ManagedProcess({ file: "/bin/sh", args: ["-c", "sleep 30 & echo $!; wait"] });
    const grandchild = await new Promise<number>((resolve) => proc.child.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
    expect(() => process.kill(grandchild, 0)).not.toThrow();
    await proc.terminate(500);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("bounds a command's time and output", async () => {
    const slow = await runCommand({ file: "/bin/sh", args: ["-c", "sleep 5"], timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    const loud = await runCommand({ file: "/bin/sh", args: ["-c", "yes | head -c 100000"], maxOutput: 1000 });
    expect(loud.stdout.length).toBe(1000);
    await expect(runCommand({ file: "/no/such/binary" })).rejects.toMatchObject({ code: "PROVIDER_START_FAILED" });
  });

  it("discards oversized lines without losing the next ones", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    let overflows = 0;
    readLines(stream, (l) => lines.push(l), { maxLineBytes: 10, onOverflow: () => overflows++ });
    stream.write("short\r\n");
    stream.write("x".repeat(25));
    stream.write("yyy\nok\npart");
    stream.end("ial\n");
    expect(lines).toEqual(["short", "ok", "partial"]);
    expect(overflows).toBe(1);
  });
});

describe("redaction", () => {
  it("removes credentials and the home directory", () => {
    const text = redactText(
      'Authorization: Bearer abc.def.ghijklmnop token=hunter2secret sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw in /Users/maria/file',
      { home: "/Users/maria" },
    );
    expect(text).not.toMatch(/abc\.def|hunter2|ABCDEFGHIJ|eyJhbGci|maria/);
    expect(text).toContain("~/file");
  });

  it("drops sensitive keys in structured values", () => {
    expect(redactValue({ user: "a", accessToken: "x", nested: [{ password: "p", note: "sk-1234567890abcdefghij" }] }, { home: "/h" })).toEqual({
      user: "a",
      accessToken: "[redacted]",
      nested: [{ password: "[redacted]", note: "[redacted-key]" }],
    });
  });
});
