import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiCli, createClaudeProvider, defineTool, type ClaudeProviderOptions } from "../src/index.js";
import { interpret } from "../src/providers/claude/events.js";
import { fakeClaudeSdk } from "./fakeClaudeSdk.js";
import { tempDir, textOf, until } from "./helpers.js";

const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));

async function setup(options: Partial<ClaudeProviderOptions> = {}) {
  const fake = fakeClaudeSdk();
  const ai = createAiCli({ appId: "graph", dataDir: await tempDir(), interruptGraceMs: 400, providers: [createClaudeProvider({ executable: FAKE_CLAUDE, loadSdk: fake.loadSdk, ...options })] });
  const events: import("../src/index.js").AiEvent[] = [];
  ai.onEvent((e) => events.push(e));
  const connected = async (label = "Personal") => {
    const account = await ai.createAccount({ providerId: "claude", label });
    await ai.connectAccount(account.id);
    return account;
  };
  return { ai, fake, events, connected, [Symbol.asyncDispose]: () => ai.dispose() };
}

describe("claude: installation and accounts", () => {
  it("detects the CLI and its version", async () => {
    await using s = await setup();
    expect(await s.ai.detect("claude")).toMatchObject({ status: "ready", version: "2.1.312", executable: FAKE_CLAUDE });
  });

  it("reports an older CLI as incompatible", async () => {
    await using s = await setup({ env: { FAKE_CLAUDE_VERSION: "2.0.77" } });
    expect(await s.ai.detect("claude")).toMatchObject({ status: "incompatible", version: "2.0.77", requiredVersion: "2.1.0" });
  });

  it("signs accounts in and out separately, each in its own configuration directory", async () => {
    await using s = await setup();
    const personal = await s.ai.createAccount({ providerId: "claude", label: "Personal" });
    const work = await s.ai.createAccount({ providerId: "claude", label: "Work" });
    expect(await s.ai.accountStatus(personal.id)).toEqual({ state: "disconnected" });

    expect(await s.ai.connectAccount(personal.id)).toEqual({ state: "connected", identity: `${personal.id}@example.org` });
    expect(await s.ai.accountStatus(work.id)).toEqual({ state: "disconnected" });

    await s.ai.connectAccount(work.id);
    await s.ai.logoutAccount(personal.id);
    expect(await s.ai.accountStatus(personal.id)).toEqual({ state: "disconnected" });
    expect(await s.ai.accountStatus(work.id)).toMatchObject({ state: "connected", identity: `${work.id}@example.org` });
  });

  it("reports a failed sign-in", async () => {
    await using s = await setup({ env: { FAKE_CLAUDE_LOGIN: "fail" } });
    const account = await s.ai.createAccount({ providerId: "claude" });
    await expect(s.ai.connectAccount(account.id)).rejects.toMatchObject({ code: "LOGIN_FAILED", meta: { detail: "OAuth error: access denied" } });
  });

  it("lists models without a model request", async () => {
    await using s = await setup();
    const account = await s.connected();
    expect(await s.ai.listModels(account.id)).toEqual([
      { id: "default", label: "Default (recommended)", default: true },
      { id: "opus", label: "Opus", efforts: ["low", "high", "max"] },
    ]);
    expect(s.fake.calls.at(-1)).toMatchObject({ persistSession: false, settingSources: [] });
  });

  it("refuses to open a session on a signed-out account", async () => {
    await using s = await setup();
    const account = await s.ai.createAccount({ providerId: "claude" });
    await expect(s.ai.openSession({ accountId: account.id, documentId: "d" })).rejects.toMatchObject({ code: "ACCOUNT_DISCONNECTED" });
  });
});

describe("claude: sessions", () => {
  it("runs a request with the editor's configuration and none of the user's", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak-0000000000";
    try {
      await using s = await setup();
      const account = await s.connected();
      const session = await s.ai.openSession({ accountId: account.id, documentId: "course-1", instructions: "You edit the course." });
      expect(await session.send("hello", { requestId: "r" })).toEqual({ requestId: "r", status: "completed" });
      expect(textOf(s.events, "r")).toBe("Echo: hello [history 0, model default]");
      const usage = s.events.filter((e) => e.type === "usageUpdated").map((e) => (e as { usage: object }).usage);
      expect(usage).toEqual([
        expect.objectContaining({ limitUsed: 0.42, limitResetsAt: "2033-05-18T03:33:20.000Z" }),
        expect.objectContaining({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, costUsd: 0.01 }),
      ]);

      const options = s.fake.calls.at(-1)!;
      expect(options).toMatchObject({
        systemPrompt: "You edit the course.",
        tools: ["AskUserQuestion"],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: true,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: FAKE_CLAUDE,
        sessionId: session.resumeId,
      });
      expect(options.cwd).toContain("sessions/graph/");
      expect(options.env).toMatchObject({ CLAUDE_CONFIG_DIR: account.homeDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
      expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(options.mcpServers).toEqual({});
      expect(options.allowedTools).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("serves the application's tools in-process, validated by the core", async () => {
    await using s = await setup();
    const account = await s.connected();
    const titles: string[] = [];
    const setTitle = defineTool({ name: "set_title", description: "Sets the title.", input: z.object({ title: z.string().min(1) }), run: ({ title }) => (titles.push(title), { content: "done" }) });
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d", tools: [setTitle] });
    await session.send('tool set_title {"title":"Física"}', { requestId: "ok" });
    await session.send('tool set_title {"title":""}', { requestId: "bad" });
    expect(titles).toEqual(["Física"]);
    expect(textOf(s.events, "ok")).toBe("Tool set_title said: done");
    expect(textOf(s.events, "bad")).toContain("Invalid arguments for set_title");
    expect(s.events.filter((e) => e.type === "activity" && e.requestId === "ok").map((e) => (e as { phase: string }).phase)).toEqual(["preparing", "thinking", "applying"]);
  });

  it("puts Claude's questions to the user and refuses every other built-in tool", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    session.on((e) => e.type === "question" && session.answer(e.questionId, "blue"));
    await session.send("ask", { requestId: "q" });
    expect(textOf(s.events, "q")).toBe("You chose blue");
    expect(s.events.find((e) => e.type === "question")).toMatchObject({ prompt: "Which color?", options: ["red", "blue"] });
    await session.send("bash", { requestId: "b" });
    expect(textOf(s.events, "b")).toBe("Bash deny");
  });

  it("interrupts and drops output that arrives afterwards", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    const pending = session.send("late", { requestId: "late" });
    await until(() => textOf(s.events, "late").length >= 2);
    await session.interrupt();
    expect(await pending).toEqual({ requestId: "late", status: "cancelled" });
    await new Promise((r) => setTimeout(r, 80));
    expect(textOf(s.events)).not.toContain("LATE");
    expect((await session.send("again", { requestId: "next" })).status).toBe("completed");
  });

  it("recovers from a crash by resuming the same conversation", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    await session.send("one", { requestId: "a" });
    const first = session.resumeId;
    expect(await session.send("crash", { requestId: "boom" })).toMatchObject({ status: "failed", error: { code: "PROVIDER_CRASHED" } });
    expect(await session.send("two", { requestId: "b" })).toMatchObject({ status: "completed" });
    expect(s.fake.calls.at(-1)).toMatchObject({ resume: first });
    expect(textOf(s.events, "b")).toBe("Echo: two [history 1, model default]");
  });

  it("maps Claude's errors and changes the model in place", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    expect(await session.send("rate-limit")).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });
    await session.updateOptions({ model: "opus" });
    await session.send("hi", { requestId: "m" });
    expect(textOf(s.events, "m")).toContain("model opus");
  });
});

describe("claude: message interpretation", () => {
  it("ignores subagent output and maps the end of a turn", () => {
    expect(interpret({ type: "stream_event", parent_tool_use_id: "x", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } } } as never)).toEqual([]);
    const aborted = interpret({ type: "result", subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_tools", usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0 } as never);
    expect(aborted.at(-1)).toEqual({ kind: "end", outcome: "cancelled" });
    const failed = interpret({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many turns"], usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0 } as never);
    expect(failed.at(-1)).toMatchObject({ kind: "fail", error: { code: "PROVIDER_ERROR", meta: { providerCode: "error_max_turns" } } });
    expect(interpret({ type: "assistant", parent_tool_use_id: null, error: "authentication_failed" } as never)).toMatchObject([{ kind: "error", error: { code: "ACCOUNT_EXPIRED" } }]);
    expect(interpret({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 87 } } as never)).toEqual([{ kind: "usage", usage: { limitUsed: 0.87 } }]);
  });
});
