import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAiCli, createClaudeProvider, createCodexProvider, type LoginPrompt } from "../src/index.js";
import { runStdioHost } from "../src/host/stdio.js";
import { tempDir } from "./helpers.js";

const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));

async function claude(mode?: "code" | "fail") {
  const ai = createAiCli({ appId: "test", dataDir: await tempDir(), providers: [createClaudeProvider({ executable: FAKE_CLAUDE, ...(mode ? { env: { FAKE_CLAUDE_LOGIN: mode } } : {}) })] });
  const account = await ai.createAccount({ providerId: "claude", label: "Work" });
  return { ai, account, [Symbol.asyncDispose]: () => ai.dispose() };
}

describe("sign-in without a working browser", () => {
  it("offers the address even when the browser finishes the sign-in", async () => {
    await using s = await claude();
    const prompts: LoginPrompt[] = [];
    expect(await s.ai.connectAccount(s.account.id, { onLogin: (p) => prompts.push(p) })).toMatchObject({ state: "connected" });
    expect(prompts).toEqual([{ url: "https://claude.com/cai/oauth/authorize?code=true&client_id=fake-client&response_type=code&state=fake-state", acceptsCode: true }]);
  });

  it("completes with the code the user pastes", async () => {
    await using s = await claude("code");
    const status = await s.ai.connectAccount(s.account.id, { onLogin: () => setTimeout(() => s.ai.submitLoginCode(s.account.id, "  good-code  "), 20) });
    expect(status).toEqual({ state: "connected", identity: `${s.account.id}@example.org` });
  });

  it("reports a wrong code as a failed sign-in", async () => {
    await using s = await claude("code");
    const pending = s.ai.connectAccount(s.account.id, { onLogin: () => setTimeout(() => s.ai.submitLoginCode(s.account.id, "wrong"), 20) });
    await expect(pending).rejects.toMatchObject({ code: "LOGIN_FAILED", meta: { detail: expect.stringContaining("Invalid code") } });
    expect(await s.ai.accountStatus(s.account.id)).toEqual({ state: "disconnected" });
  });

  it("refuses codes nobody is waiting for, and codes that are not one line", async () => {
    await using s = await claude("code");
    expect(() => s.ai.submitLoginCode(s.account.id, "good-code")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    let tried = false;
    const pending = s.ai.connectAccount(s.account.id, {
      onLogin: () =>
        setTimeout(() => {
          expect(() => s.ai.submitLoginCode(s.account.id, "good-code\nextra")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
          expect(() => s.ai.submitLoginCode(s.account.id, "   ")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
          tried = true;
          s.ai.submitLoginCode(s.account.id, "good-code");
        }, 20),
    });
    expect(await pending).toMatchObject({ state: "connected" });
    expect(tried).toBe(true);
  });

  it("cancels a sign-in that is waiting for a code", async () => {
    await using s = await claude("code");
    const controller = new AbortController();
    const pending = s.ai.connectAccount(s.account.id, { signal: controller.signal, onLogin: () => setTimeout(() => controller.abort(), 20) });
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    // The account can sign in again afterwards.
    expect(() => s.ai.submitLoginCode(s.account.id, "good-code")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("offers Codex's address without asking for a code", async () => {
    const ai = createAiCli({ appId: "test", dataDir: await tempDir(), providers: [createCodexProvider({ executable: FAKE_CODEX })] });
    try {
      const account = await ai.createAccount({ providerId: "codex" });
      const prompts: LoginPrompt[] = [];
      expect(await ai.connectAccount(account.id, { onLogin: (p) => prompts.push(p) })).toEqual({ state: "connected" });
      expect(prompts).toEqual([{ url: "https://auth.openai.com/oauth/authorize?response_type=code&client_id=fake-client&state=fake-state", acceptsCode: false }]);
    } finally {
      await ai.dispose();
    }
  });

  it("relays the address and the pasted code over the stdio host", async () => {
    await using s = await claude("code");
    const input = new PassThrough();
    const output = new PassThrough();
    const host = runStdioHost({ ai: s.ai, input, output });
    const lines: any[] = [];
    let answered!: (msg: any) => void;
    const result = new Promise<any>((r) => (answered = r));
    createInterface({ input: output }).on("line", (line) => {
      const msg = JSON.parse(line);
      lines.push(msg);
      if (msg.login) input.write(JSON.stringify({ id: 2, method: "accounts.submitCode", params: { accountId: msg.login.accountId, code: "good-code" } }) + "\n");
      if (msg.id === 1) answered(msg);
    });
    input.write(JSON.stringify({ id: 1, method: "accounts.connect", params: { accountId: s.account.id } }) + "\n");
    expect((await result).result).toMatchObject({ state: "connected" });
    expect(lines.find((m) => m.login)).toEqual({ login: { requestId: 1, accountId: s.account.id, url: expect.stringContaining("/oauth/authorize"), acceptsCode: true } });
    expect(lines.find((m) => m.id === 2)).toEqual({ id: 2, result: null });
    input.end();
    await host.closed;
  });
});
