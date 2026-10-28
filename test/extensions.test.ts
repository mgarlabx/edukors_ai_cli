import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAiCli, createClaudeProvider, createCodexProvider, type AiEvent, type AuthorizationRequest, type ProviderAdapter } from "../src/index.js";
import { fakeClaudeSdk } from "./fakeClaudeSdk.js";
import { tempDir, textOf } from "./helpers.js";

const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const FAKE_MCP = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));

const glossary = { glossary: { command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_SECRET: "s3" } } };

const providers: { id: "claude" | "codex"; make: () => { adapter: ProviderAdapter; calls?: ReturnType<typeof fakeClaudeSdk>["calls"] } }[] = [
  {
    id: "claude",
    make: () => {
      const fake = fakeClaudeSdk();
      return { adapter: createClaudeProvider({ executable: FAKE_CLAUDE, loadSdk: fake.loadSdk }), calls: fake.calls };
    },
  },
  { id: "codex", make: () => ({ adapter: createCodexProvider({ executable: FAKE_CODEX }) }) },
];

async function setup(id: "claude" | "codex") {
  const made = providers.find((p) => p.id === id)!.make();
  const ai = createAiCli({ appId: "graph", dataDir: await tempDir(), interruptGraceMs: 400, providers: [made.adapter] });
  const events: AiEvent[] = [];
  ai.onEvent((e) => events.push(e));
  const account = await ai.createAccount({ providerId: id });
  await ai.connectAccount(account.id);
  return { ai, account, events, calls: made.calls, [Symbol.asyncDispose]: () => ai.dispose() };
}

describe.each(["claude", "codex"] as const)("%s: the user's MCP servers", (id) => {
  it("offers a user's server through the core, authorized by the application", async () => {
    await using s = await setup(id);
    const asked: Omit<AuthorizationRequest, "signal">[] = [];
    const session = await s.ai.openSession({
      accountId: s.account.id,
      documentId: "course-1",
      mcpServers: glossary,
      authorize: ({ signal, ...request }) => (asked.push(request), { allow: true }),
    });
    expect(s.events.find((e) => e.type === "mcpServerStatus")).toMatchObject({ server: "glossary", status: "connected", tools: 2 });

    await session.send('mcp glossary lookup {"term":"vetor"}', { requestId: "r" });
    expect(textOf(s.events, "r")).toBe("glossary.lookup said: vetor: a term from the glossary (env s3)");
    expect(asked).toEqual([{ kind: "mcp", callId: expect.any(String), server: "glossary", tool: "lookup", input: { term: "vetor" }, documentId: "course-1", requestId: "r" }]);
    expect(s.events.filter((e) => e.requestId === "r" && e.type.startsWith("tool"))).toMatchObject([
      { type: "toolStarted", tool: "mcp__glossary__lookup" },
      { type: "toolCompleted", tool: "mcp__glossary__lookup", ok: true },
    ]);

    await session.send("mcp glossary broken", { requestId: "b" });
    expect(textOf(s.events, "b")).toBe("glossary.broken said: the glossary is offline (error)");
    expect(s.events.find((e) => e.requestId === "b" && e.type === "toolCompleted")).toMatchObject({ ok: false, errorCode: "TOOL_FAILED" });
  });

  it("does not call the server when the application declines, or has no authorizer", async () => {
    await using s = await setup(id);
    const declined = await s.ai.openSession({ accountId: s.account.id, documentId: "d", mcpServers: glossary, authorize: () => ({ allow: false, message: "Not now." }) });
    await declined.send('mcp glossary lookup {"term":"x"}', { requestId: "no" });
    expect(textOf(s.events, "no")).toBe("glossary.lookup said: Not now. (error)");
    expect(s.events.find((e) => e.requestId === "no" && e.type === "toolCompleted")).toMatchObject({ ok: false, errorCode: "TOOL_DENIED" });

    const unattended = await s.ai.openSession({ accountId: s.account.id, documentId: "e", mcpServers: glossary });
    await unattended.send('mcp glossary lookup {"term":"x"}', { requestId: "none" });
    expect(s.events.find((e) => e.requestId === "none" && e.type === "toolCompleted")).toMatchObject({ errorCode: "TOOL_DENIED" });
  });

  it("reports servers that cannot be used, and opens the session anyway", async () => {
    await using s = await setup(id);
    const session = await s.ai.openSession({
      accountId: s.account.id,
      documentId: "d",
      mcpServers: { "bad name!": { command: "x" }, edukors: { command: "x" }, missing: { command: "/no/such/server" }, noUrl: { type: "http" } },
      authorize: () => ({ allow: true }),
    });
    const statuses = s.events.filter((e) => e.type === "mcpServerStatus").map((e) => ({ server: (e as { server: string }).server, status: (e as { status: string }).status }));
    expect(statuses).toEqual(expect.arrayContaining([
      { server: "bad name!", status: "failed" },
      { server: "edukors", status: "failed" },
      { server: "missing", status: "failed" },
      { server: "noUrl", status: "failed" },
    ]));
    expect((await session.send("hello")).status).toBe("completed");
  });
});

describe("skills", () => {
  async function skillsFolder() {
    const dir = join(await tempDir(), "skills");
    for (const [folder, name] of [["course-outline", "course-outline"], ["quiz", "Quiz Writer"]]) {
      mkdirSync(join(dir, folder!), { recursive: true });
      writeFileSync(join(dir, folder!, "SKILL.md"), `---\nname: ${name}\ndescription: Helps with ${folder}.\n---\n\nInstructions.\n`);
    }
    return dir;
  }

  it("claude: offers only the application's skills, through a local plugin", async () => {
    await using s = await setup("claude");
    const dir = await skillsFolder();
    await s.ai.openSession({ accountId: s.account.id, documentId: "d", skillsDir: dir });
    const options = s.calls!.at(-1)!;
    expect(options.tools).toEqual(["AskUserQuestion", "Skill"]);
    expect(new Set(options.skills as string[])).toEqual(new Set(["edukors:course-outline", "edukors:quiz", "edukors:Quiz Writer"]));
    const plugin = options.plugins![0]!.path;
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "edukors" });
    expect(lstatSync(join(plugin, "skills")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(plugin, "skills", "quiz", "SKILL.md"))).toBe(true);
    // Loading a skill is allowed; other built-in tools are not.
    expect(await options.canUseTool!("Skill", { skill: "edukors:quiz" }, {} as never)).toMatchObject({ behavior: "allow" });
    expect(await options.canUseTool!("Bash", { command: "ls" }, {} as never)).toMatchObject({ behavior: "deny" });
  });

  it("claude: without a skills folder, no skill is offered", async () => {
    await using s = await setup("claude");
    await s.ai.openSession({ accountId: s.account.id, documentId: "d" });
    const options = s.calls!.at(-1)!;
    expect(options.tools).toEqual(["AskUserQuestion"]);
    expect(options.plugins).toBeUndefined();
    expect(await options.canUseTool!("Skill", {}, {} as never)).toMatchObject({ behavior: "deny" });
  });

  it("codex: serves the application's skills through read_skill, with every native skill off", async () => {
    await using s = await setup("codex");
    const dir = await skillsFolder();
    mkdirSync(join(dir, "quiz", "references"));
    writeFileSync(join(dir, "quiz", "references", "rubric.md"), "Rubric text.");
    writeFileSync(join(dir, "..", "secret.txt"), "outside");
    const session = await s.ai.openSession({ accountId: s.account.id, documentId: "d", skillsDir: dir });
    // Codex reads native skills with shell commands: all of them are off, the application's included.
    expect(JSON.parse(readFileSync(join(s.account.homeDir, "skill-switches.json"), "utf8"))).toEqual({ "/bundled/imagegen/SKILL.md": false });

    await session.send("developer", { requestId: "dev" });
    expect(textOf(s.events, "dev")).toContain("- course-outline: Helps with course-outline.");
    expect(textOf(s.events, "dev")).toContain("- Quiz Writer: Helps with quiz.");
    await session.send("skill course-outline", { requestId: "read" });
    expect(textOf(s.events, "read")).toContain("Instructions.");
    await session.send("skill quiz references/rubric.md", { requestId: "file" });
    expect(textOf(s.events, "file")).toBe("Rubric text.");
    await session.send("skill quiz ../../secret.txt", { requestId: "escape" });
    expect(textOf(s.events, "escape")).toBe("error: the file must be a path inside the skill's folder");
    expect(s.events.filter((e) => e.requestId === "read" && e.type === "activity").map((e) => (e as { phase: string }).phase)).toContain("reading");
  });

  it("codex: without a skills folder, nothing about skills is offered", async () => {
    await using s = await setup("codex");
    const session = await s.ai.openSession({ accountId: s.account.id, documentId: "d" });
    await session.send("developer", { requestId: "dev" });
    expect(textOf(s.events, "dev")).toBe("none");
    await session.send("skill quiz", { requestId: "read" });
    expect(textOf(s.events, "read")).toBe("error: no MCP server edukors");
  });

  it("refuses a relative skills folder", async () => {
    await using s = await setup("codex");
    await expect(s.ai.openSession({ accountId: s.account.id, documentId: "d", skillsDir: "skills" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("skill files", () => {
  it("finds skills by name or folder, reads folded descriptions, and stays inside the skill", async () => {
    const { listSkills, readSkillFile } = await import("../src/skills.js");
    const { symlinkSync } = await import("node:fs");
    const root = await tempDir();
    const dir = join(root, "skills");
    mkdirSync(join(dir, "writer"), { recursive: true });
    writeFileSync(join(dir, "writer", "SKILL.md"), "---\nname: \"Quiz Writer\"\ndescription: >\n  Writes quizzes\n  for courses.\n---\nBody.");
    writeFileSync(join(root, "outside.txt"), "secret");
    symlinkSync(join(root, "outside.txt"), join(dir, "writer", "link.txt"));
    expect(listSkills(dir)).toEqual([{ folder: "writer", name: "Quiz Writer", description: "Writes quizzes for courses." }]);
    expect(readSkillFile(dir, "Quiz Writer")).toContain("Body.");
    expect(readSkillFile(dir, "writer")).toContain("Body.");
    expect(() => readSkillFile(dir, "writer", "link.txt")).toThrow("inside the skill's folder");
    expect(() => readSkillFile(dir, "writer", "/etc/hosts")).toThrow("inside the skill's folder");
    expect(() => readSkillFile(dir, "nobody")).toThrow('there is no skill named "nobody"');
  });
});

describe("over the stdio host", () => {
  it("asks the application to authorize each call to a user's server", async () => {
    const { PassThrough } = await import("node:stream");
    const { createInterface } = await import("node:readline");
    const { runStdioHost } = await import("../src/host/stdio.js");
    await using s = await setup("codex");
    const input = new PassThrough();
    const output = new PassThrough();
    const host = runStdioHost({ ai: s.ai, input, output });
    const waiting = new Map<number, (m: any) => void>();
    const authorizations: any[] = [];
    createInterface({ input: output }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.method === "tool.authorize") {
        authorizations.push(m.params);
        const allow = authorizations.length > 1;
        input.write(JSON.stringify({ id: m.id, result: allow ? { allow: true } : { allow: false, message: "Ask me first." } }) + "\n");
      } else if (typeof m.id === "number") waiting.get(m.id)?.(m);
    });
    let next = 1;
    const call = (method: string, params: object) =>
      new Promise<any>((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        input.write(JSON.stringify({ id, method, params }) + "\n");
      });
    const { sessionId } = (await call("session.open", { accountId: s.account.id, documentId: "c1", mcpServers: glossary })).result;
    await call("session.send", { sessionId, text: 'mcp glossary lookup {"term":"a"}', requestId: "r1" });
    await call("session.send", { sessionId, text: 'mcp glossary lookup {"term":"b"}', requestId: "r2" });
    expect(textOf(s.events, "r1")).toBe("glossary.lookup said: Ask me first. (error)");
    expect(textOf(s.events, "r2")).toBe("glossary.lookup said: b: a term from the glossary (env s3)");
    expect(authorizations).toEqual([
      { sessionId, kind: "mcp", callId: expect.any(String), server: "glossary", tool: "lookup", input: { term: "a" }, documentId: "c1", requestId: "r1" },
      { sessionId, kind: "mcp", callId: expect.any(String), server: "glossary", tool: "lookup", input: { term: "b" }, documentId: "c1", requestId: "r2" },
    ]);
    input.end();
    await host.closed;
  });
});

describe("settings: MCP configuration", () => {
  it("accepts the .mcp.json shape or a bare object, and reports every problem", async () => {
    const { parseMcpConfig } = await import("../src/index.js");
    const text = JSON.stringify({
      mcpServers: {
        files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Courses"] },
        docs: { type: "http", url: "https://example.org/mcp", timeout: 30000 },
        edukors: { command: "x" },
        "my.server": { command: "x" },
        nourl: { type: "sse", url: "ftp://x" },
        weird: { type: "websocket", url: "wss://x" },
        badargs: { command: "x", args: "not-a-list" },
      },
    });
    const { servers, problems } = parseMcpConfig(text);
    expect(servers).toEqual({
      files: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Courses"] },
      docs: { type: "http", url: "https://example.org/mcp", timeout: 30000 },
    });
    expect(problems).toEqual([
      { code: "reserved", server: "edukors" },
      { code: "badName", server: "my.server" },
      { code: "noUrl", server: "nourl" },
      { code: "badType", server: "weird", detail: "websocket" },
      { code: "badField", server: "badargs", field: "args" },
    ]);
    expect(parseMcpConfig('{ "a": { "command": "x" } }').servers).toEqual({ a: { type: "stdio", command: "x" } });
    expect(parseMcpConfig("").problems).toEqual([]);
    expect(parseMcpConfig("{ nope").problems[0]).toMatchObject({ code: "notJson" });
    expect(parseMcpConfig("[1]").problems).toEqual([{ code: "notServers" }]);
  });
});
