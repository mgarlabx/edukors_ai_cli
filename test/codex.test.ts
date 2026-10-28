import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiCli, createCodexProvider, defineTool, Diagnostics, startToolBridge, type AiEvent, type CodexProviderOptions } from "../src/index.js";
import { codexError, codexLimits } from "../src/providers/codex/adapter.js";
import { tempDir, textOf, until } from "./helpers.js";

const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

async function setup(options: Partial<CodexProviderOptions> = {}) {
  const ai = createAiCli({ appId: "slides", dataDir: await tempDir(), interruptGraceMs: 400, providers: [createCodexProvider({ executable: FAKE_CODEX, ...options })] });
  const events: AiEvent[] = [];
  ai.onEvent((e) => events.push(e));
  const connected = async (label = "Personal") => {
    const account = await ai.createAccount({ providerId: "codex", label });
    await ai.connectAccount(account.id);
    return account;
  };
  return { ai, events, connected, [Symbol.asyncDispose]: () => ai.dispose() };
}

describe("codex: installation and accounts", () => {
  it("detects the CLI and refuses versions older than the verified one", async () => {
    await using s = await setup();
    expect(await s.ai.detect("codex")).toMatchObject({ status: "ready", version: "0.164.0" });
    await using old = await setup({ env: { FAKE_CODEX_VERSION: "0.150.2" } });
    expect(await old.ai.detect("codex")).toMatchObject({ status: "incompatible", version: "0.150.2", requiredVersion: "0.164.0" });
    const account = await old.ai.createAccount({ providerId: "codex" });
    await expect(old.ai.openSession({ accountId: account.id, documentId: "d" })).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
  });

  it("keeps each account's sign-in in its own home, never the user's", async () => {
    await using s = await setup();
    const personal = await s.ai.createAccount({ providerId: "codex", label: "Personal" });
    const work = await s.ai.createAccount({ providerId: "codex", label: "Work" });
    expect(await s.ai.accountStatus(personal.id)).toEqual({ state: "disconnected" });
    expect(await s.ai.connectAccount(personal.id)).toEqual({ state: "connected" });
    expect(await s.ai.accountStatus(work.id)).toEqual({ state: "disconnected" });
    expect(existsSync(join(personal.homeDir, "auth.json"))).toBe(true);
    expect(existsSync(join(work.homeDir, "auth.json"))).toBe(false);
    await s.ai.logoutAccount(personal.id);
    expect(await s.ai.accountStatus(personal.id)).toEqual({ state: "disconnected" });
  });

  it("reports a failed sign-in", async () => {
    await using s = await setup({ env: { FAKE_CODEX_LOGIN: "fail" } });
    const account = await s.ai.createAccount({ providerId: "codex" });
    await expect(s.ai.connectAccount(account.id)).rejects.toMatchObject({ code: "LOGIN_FAILED", meta: { detail: "login cancelled" } });
  });

  it("lists models and reads the account's usage limits", async () => {
    await using s = await setup();
    const account = await s.connected();
    expect(await s.ai.listModels(account.id)).toEqual([{ id: "gpt-fake", label: "GPT Fake", efforts: ["low", "high"], default: true }]);
    expect(await s.ai.readUsage(account.id)).toMatchObject({ limitUsed: 0.42, limitResetsAt: "2033-05-18T03:33:20.000Z", observedAt: expect.any(String) });
  });

  it("refuses to open a session on a signed-out account", async () => {
    await using s = await setup();
    const account = await s.ai.createAccount({ providerId: "codex" });
    await expect(s.ai.openSession({ accountId: account.id, documentId: "d" })).rejects.toMatchObject({ code: "ACCOUNT_DISCONNECTED" });
  });
});

describe("codex: sessions", () => {
  it("runs a request read-only, with the editor's instructions and options", async () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak-000000000000";
    try {
      await using s = await setup();
      const account = await s.connected();
      const session = await s.ai.openSession({ accountId: account.id, documentId: "deck", instructions: "Edit slides.", options: { model: "gpt-fake" } });
      expect(await session.send("hello", { requestId: "r" })).toEqual({ requestId: "r", status: "completed" });
      expect(textOf(s.events, "r")).toBe("Echo: hello [history 0, model gpt-fake, effort default, mcp off, instructions Edit slides.]");
      expect(s.events.find((e) => e.type === "usageUpdated" && e.requestId === "r")).toMatchObject({ usage: { inputTokens: 5 } });
      await session.updateOptions({ effort: "high" });
      await session.send("env", { requestId: "e" });
      expect(textOf(s.events, "e")).toBe(`OPENAI_API_KEY=absent home=${account.id} sandbox=read-only approval=untrusted`);
      // Codex's own skills were switched off in the account's home, not the user's.
      expect(JSON.parse(readFileSync(join(account.homeDir, "skills-off.json"), "utf8"))).toEqual({ path: "/bundled/imagegen/SKILL.md", enabled: false });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("calls the application's tools over the authenticated local bridge", async () => {
    await using s = await setup();
    const account = await s.connected();
    const applied: string[] = [];
    const tool = defineTool({ name: "add_slide", description: "Adds a slide.", input: z.object({ title: z.string() }), run: ({ title }) => (applied.push(title), { content: "added" }) });
    const session = await s.ai.openSession({ accountId: account.id, documentId: "deck", tools: [tool] });
    await session.send('tool add_slide {"title":"Introdução"}', { requestId: "t" });
    await session.send('tool add_slide {"title":7}', { requestId: "bad" });
    expect(applied).toEqual(["Introdução"]);
    expect(textOf(s.events, "t")).toBe("Tool add_slide said: added");
    expect(textOf(s.events, "bad")).toContain("Invalid arguments for add_slide");
    expect(s.events.filter((e) => e.requestId === "t").map((e) => e.type)).toContain("toolCompleted");
  });

  it("asks the user, and declines commands", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    session.on((e) => e.type === "question" && session.answer(e.questionId, "red"));
    await session.send("ask", { requestId: "q" });
    expect(textOf(s.events, "q")).toBe("You chose red");
    await session.send("comando", { requestId: "c" });
    expect(textOf(s.events, "c")).toBe("Command decline");
  });

  it("interrupts and drops output that arrives afterwards", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    const pending = session.send("late", { requestId: "late" });
    await until(() => textOf(s.events, "late").length >= 2);
    await session.interrupt();
    expect(await pending).toEqual({ requestId: "late", status: "cancelled" });
    await until(() => session.lateEventsDropped > 0);
    expect(textOf(s.events)).not.toContain("LATE");
  });

  it("recovers from a crash by resuming the thread", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    await session.send("one", { requestId: "a" });
    const thread = session.resumeId;
    expect(await session.send("crash")).toMatchObject({ status: "failed", error: { code: "PROVIDER_CRASHED" } });
    await session.send("two", { requestId: "b" });
    expect(session.resumeId).toBe(thread);
    expect(textOf(s.events, "b")).toContain("[history 1,");
  });

  it("maps a usage limit to RATE_LIMITED", async () => {
    await using s = await setup();
    const account = await s.connected();
    const session = await s.ai.openSession({ accountId: account.id, documentId: "d" });
    expect(await session.send("limit")).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });
    expect((await session.send("after")).status).toBe("completed");
  });

  it("runs two documents on one account at once without sharing state", async () => {
    await using s = await setup();
    const account = await s.connected();
    const tool = (name: string) => defineTool({ name: "whoami", description: "", input: z.object({}), run: () => ({ content: name }) });
    const a = await s.ai.openSession({ accountId: account.id, documentId: "a", tools: [tool("A")] });
    const b = await s.ai.openSession({ accountId: account.id, documentId: "b", tools: [tool("B")] });
    await Promise.all([a.send("tool whoami", { requestId: "ra" }), b.send("tool whoami", { requestId: "rb" })]);
    expect(textOf(s.events, "ra")).toBe("Tool whoami said: A");
    expect(textOf(s.events, "rb")).toBe("Tool whoami said: B");
    expect(a.resumeId).not.toBe(b.resumeId);
    expect(existsSync(join(account.homeDir, "config.toml"))).toBe(false);
  });
});

describe("codex: protocol mapping", () => {
  it("takes the most used window as the account's limit", () => {
    expect(codexLimits({ rateLimitsByLimitId: { a: { primary: { usedPercent: 20 } }, b: { secondary: { usedPercent: 75, resetsAt: 1 } } } })).toEqual({ limitUsed: 0.75, limitResetsAt: "1970-01-01T00:00:01.000Z" });
    expect(codexLimits({})).toBeNull();
    expect(codexError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } })).toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    expect(codexError({ codexErrorInfo: "unauthorized" })).toMatchObject({ code: "ACCOUNT_EXPIRED" });
  });
});

describe("tool bridge", () => {
  it("binds to 127.0.0.1 and refuses requests without its token", async () => {
    const bridge = await startToolBridge([], async () => ({ content: "" }), new Diagnostics().scoped("t"));
    try {
      expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
      expect((await fetch(bridge.url, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(bridge.url, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      const list = await fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(list.status).toBe(200);
    } finally {
      await bridge.close();
    }
  });
});
