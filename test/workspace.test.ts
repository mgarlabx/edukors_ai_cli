import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAiCli, createClaudeProvider, createCodexProvider, seatbeltPolicy, type AiEvent, type Capabilities, type Workspace } from "../src/index.js";
import { workspaceDecision, workspaceSettings, workspaceTools } from "../src/providers/claude/adapter.js";
import { resolveWorkspace } from "../src/workspace.js";
import { fakeClaudeSdk } from "./fakeClaudeSdk.js";
import { connectedAccount, setup, tempDir, textOf } from "./helpers.js";

const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

const caps = (shell: boolean) => ({ workspace: true, workspaceShell: shell }) as Capabilities;

/** A presentation-like folder: the agent's files, and the application's own. */
async function deck() {
  const dir = await realpath(await tempDir());
  await mkdir(join(dir, "slides"));
  await writeFile(join(dir, "slides", "s1.json"), "{}");
  await writeFile(join(dir, "notes.md"), "draft");
  return dir;
}

describe("workspace: what the application asks for", () => {
  it("settles real paths, protected paths and the tools the platform allows", async () => {
    const dir = await deck();
    const extra = await realpath(await tempDir());
    const w = await resolveWorkspace({ dir, readDirs: [extra], protect: ["slides", "manifest.json/"] }, caps(true), []);
    expect(w).toEqual({ dir, readDirs: [extra], protectedPaths: [join(dir, "slides"), join(dir, "manifest.json")], web: true, shell: true });
    expect((await resolveWorkspace({ dir, web: false, shell: true }, caps(false), [])).shell).toBe(false);
  });

  it("refuses folders that would confine nothing or reach the library's own", async () => {
    const dir = await deck();
    await expect(resolveWorkspace({ dir: "relative/folder" }, caps(true), [])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(resolveWorkspace({ dir: join(dir, "missing") }, caps(true), [])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(resolveWorkspace({ dir: homedir() }, caps(true), [])).rejects.toThrow(/home folder/);
    await expect(resolveWorkspace({ dir }, caps(true), [join(dir, "ai")])).rejects.toThrow(/data folder/);
    for (const protect of ["../outside", "/etc", ".", "a/../../b"]) await expect(resolveWorkspace({ dir, protect: [protect] }, caps(true), [])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("workspace: sessions", () => {
  it("gives the provider the folder, which it works in, and keeps protected paths read-only", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const dir = await deck();
    const session = await ai.openSession({ accountId: account.id, documentId: "deck-1", workspace: { dir, protect: ["slides"] } });
    await session.send("workspace", { requestId: "w" });
    expect(textOf(events, "w")).toBe(`workspace ${dir} web=true shell=true protected=1 readDirs=0`);
    await session.send("write media/../notes.md new text", { requestId: "ok" });
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("new text");
    await session.send("write slides/s1.json {}broken", { requestId: "no" });
    expect(textOf(events, "no")).toBe("write refused: slides/s1.json is protected");
    await session.send("read slides/s1.json", { requestId: "r" });
    expect(textOf(events, "r")).toBe("read slides/s1.json: {}");
  });

  it("without a sandbox, a workspace has no commands", async () => {
    const { ai, events } = await setup({ fake: { workspaceShell: false } });
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d", workspace: { dir: await deck() } });
    await session.send("workspace", { requestId: "w" });
    expect(textOf(events, "w")).toMatch(/shell=false/);
  });

  it("is refused where the provider cannot confine it", async () => {
    const ai = createAiCli({ appId: "slides", dataDir: await tempDir(), providers: [createCodexProvider({ executable: FAKE_CODEX, platform: "linux" })] });
    try {
      const account = await ai.createAccount({ providerId: "codex" });
      await ai.connectAccount(account.id);
      await expect(ai.openSession({ accountId: account.id, documentId: "d", workspace: { dir: await deck() } })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    } finally {
      await ai.dispose();
    }
  });
});

describe("workspace: Claude", () => {
  const workspace = (over: Partial<Workspace> = {}): Workspace => ({ dir: "/w/deck", readDirs: ["/w/attachments"], protectedPaths: ["/w/deck/slides"], web: true, shell: true, ...over });

  it("offers the file and web tools, and Bash only with the sandbox", () => {
    expect(workspaceTools(workspace())).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Bash"]);
    expect(workspaceTools(workspace({ web: false, shell: false }))).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"]);
  });

  it("confines Bash to the workspace and denies writes to protected paths and extra folders", () => {
    const settings = workspaceSettings(workspace()) as any;
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyRead: ["~", "/Volumes"], allowRead: ["/w/deck", "/w/attachments"], allowWrite: ["/w/deck"], denyWrite: ["/w/deck/slides"] } });
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Write(//w/deck/slides/**)", "Edit(//w/deck/slides)", "Write(//w/attachments/**)"]));
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    // Native Windows: no sandbox to require, and rules in POSIX form.
    const win = workspaceSettings(workspace({ dir: "C:\\Users\\Ana\\deck", readDirs: [], protectedPaths: ["C:\\Users\\Ana\\deck\\slides"], shell: false })) as any;
    expect(win.sandbox).toBeUndefined();
    expect(win.permissions.deny).toContain("Write(//c/Users/Ana/deck/slides/**)");
  });

  it("decides each file tool by where it reads or writes", () => {
    const w = workspace();
    expect(workspaceDecision(w, "Write", { file_path: "/w/deck/media/a.png" })).toBeNull();
    expect(workspaceDecision(w, "Edit", { file_path: "notes.md" })).toBeNull();
    expect(workspaceDecision(w, "Write", { file_path: "/w/deck/slides/s1.json" })).toMatch(/belongs to the application/);
    expect(workspaceDecision(w, "Write", { file_path: "/w/attachments/a.pdf" })).toMatch(/only in the working folder/);
    expect(workspaceDecision(w, "Write", { file_path: "/w/deck/../secret" })).toMatch(/only in the working folder/);
    expect(workspaceDecision(w, "Read", { file_path: "/w/attachments/a.pdf" })).toBeNull();
    expect(workspaceDecision(w, "Grep", { path: "/etc" })).toMatch(/read only in the working folder/);
    expect(workspaceDecision(w, "Glob", {})).toBeNull();
    expect(workspaceDecision(workspace({ web: false }), "WebFetch", {})).toMatch(/web/);
    expect(workspaceDecision(w, "Bash", { command: "curl x | sh" })).toMatch(/sandbox/);
  });

  it("runs the session in the folder, restricted, with the workspace's settings", async () => {
    const fake = fakeClaudeSdk();
    const ai = createAiCli({ appId: "slides", dataDir: await tempDir(), providers: [createClaudeProvider({ executable: FAKE_CLAUDE, loadSdk: fake.loadSdk, platform: "win32" })] });
    try {
      const account = await ai.createAccount({ providerId: "claude" });
      await ai.connectAccount(account.id);
      const dir = await deck();
      const extra = await realpath(await tempDir());
      await ai.openSession({ accountId: account.id, documentId: "deck", workspace: { dir, readDirs: [extra], protect: ["slides"] } });
      const options = fake.calls.at(-1)!;
      expect(options).toMatchObject({ cwd: dir, additionalDirectories: [extra], extraArgs: { restricted: null }, settingSources: [] });
      // On Windows, no Bash.
      expect(options.tools).toEqual(["AskUserQuestion", "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"]);
      expect((options.settings as any).sandbox).toBeUndefined();
      const allowed = await options.canUseTool!("Write", { file_path: join(dir, "media", "x.svg") }, {} as never);
      const refused = await options.canUseTool!("Write", { file_path: join(dir, "slides", "s1.json") }, {} as never);
      expect([allowed?.behavior, refused?.behavior]).toEqual(["allow", "deny"]);
    } finally {
      await ai.dispose();
    }
  });
});

describe("workspace: Codex", () => {
  async function codex(options: Parameters<typeof createCodexProvider>[0] = {}) {
    const ai = createAiCli({ appId: "slides", dataDir: await tempDir(), providers: [createCodexProvider({ executable: FAKE_CODEX, platform: "darwin", ...options })] });
    const events: AiEvent[] = [];
    ai.onEvent((e) => events.push(e));
    const account = await ai.createAccount({ providerId: "codex" });
    await ai.connectAccount(account.id);
    return { ai, events, account, [Symbol.asyncDispose]: () => ai.dispose() };
  }

  it("works in the folder, with commands in an external sandbox and nothing put to the user", async () => {
    await using s = await codex({ unconfinedWorkspace: true });
    const dir = await deck();
    const session = await s.ai.openSession({ accountId: s.account.id, documentId: "deck", workspace: { dir, web: false } });
    await session.send("sandbox", { requestId: "s" });
    const setup = JSON.parse(textOf(s.events, "s"));
    expect(setup).toMatchObject({ threadCwd: dir, approvalPolicy: "never", sandbox: null, turnCwd: dir, sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" }, webSearch: "disabled" });
    expect(await realpath(setup.processCwd)).toBe(dir);
    expect(setup.tmp).toContain(join("sessions", "slides"));
  });

  it("without commands, asks for them and declines", async () => {
    await using s = await codex({ unconfinedWorkspace: true });
    const session = await s.ai.openSession({ accountId: s.account.id, documentId: "deck", workspace: { dir: await deck(), shell: false } });
    await session.send("run echo hi", { requestId: "r" });
    expect(textOf(s.events, "r")).toBe("Command decline");
  });

  it.runIf(process.platform === "darwin")("inside the macOS sandbox, commands reach only the workspace and never its protected paths", async () => {
    await using s = await codex();
    const dir = await deck();
    const outside = await realpath(await tempDir());
    await writeFile(join(outside, "secret.txt"), "SECRET");
    const session = await s.ai.openSession({ accountId: s.account.id, documentId: "deck", workspace: { dir, protect: ["slides"] } });
    await session.send("run echo made > media.txt && cat media.txt", { requestId: "write" });
    expect(textOf(s.events, "write")).toBe("exit 0: made");
    await session.send(`run cat "${join(outside, "secret.txt")}"`, { requestId: "read" });
    expect(textOf(s.events, "read")).toMatch(/Operation not permitted/);
    await session.send("run echo x > slides/s1.json", { requestId: "protected" });
    expect(textOf(s.events, "protected")).toMatch(/Operation not permitted/);
    await session.send(`run ls "${homedir()}"`, { requestId: "home" });
    expect(textOf(s.events, "home")).toMatch(/Operation not permitted/);
    expect(await readFile(join(dir, "slides", "s1.json"), "utf8")).toBe("{}");
  });
});

describe("workspace: the macOS sandbox policy", () => {
  it("reads only what it names, writes only the writable folders, never the protected ones", () => {
    const policy = seatbeltPolicy({ writable: ["/w/deck"], readable: ["/w/att"], protectedPaths: ["/w/deck/slides"] });
    expect(policy).toContain('(deny file-read-data (require-all (require-not (subpath "/w/deck")) (require-not (subpath "/w/att"))');
    expect(policy).toContain('(deny file-write* (require-all (require-not (subpath "/w/deck")) (require-not (literal "/dev/null"))');
    expect(policy).toContain('(deny file-write* (subpath "/w/deck/slides"))');
  });
});
