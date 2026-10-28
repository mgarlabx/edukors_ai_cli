import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAiCli } from "../src/index.js";
import { createFakeProvider } from "../src/testing/index.js";
import { connectedAccount, setup, tempDir } from "./helpers.js";

describe("providers", () => {
  it("detects an installed, compatible CLI", async () => {
    const { ai } = await setup();
    expect(await ai.detect("fake")).toMatchObject({ providerId: "fake", status: "ready", version: "1.4.0" });
  });

  it("reports a missing CLI and refuses to use its accounts", async () => {
    const { ai } = await setup({ fake: { command: { file: "/nonexistent/fake-ai", args: [] } } });
    expect(await ai.detect("fake")).toMatchObject({ status: "missing" });
    const account = await ai.createAccount({ providerId: "fake", label: "Personal" });
    await expect(ai.connectAccount(account.id)).rejects.toMatchObject({ code: "CLI_MISSING" });
  });

  it("reports an outdated CLI as incompatible", async () => {
    const { ai } = await setup({ fake: { env: { FAKE_AI_VERSION: "0.9.1" } } });
    expect(await ai.detect("fake")).toMatchObject({ status: "incompatible", version: "0.9.1", requiredVersion: "1.0.0" });
    const account = await ai.createAccount({ providerId: "fake" });
    await expect(ai.openSession({ accountId: account.id, documentId: "d" })).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE", meta: { required: "1.0.0" } });
  });

  it("rejects unknown providers", async () => {
    const { ai } = await setup();
    await expect(ai.createAccount({ providerId: "nope" })).rejects.toMatchObject({ code: "PROVIDER_UNKNOWN" });
  });
});

describe("accounts", () => {
  it("creates, connects, renames and removes an account", async () => {
    const { ai } = await setup();
    const account = await ai.createAccount({ providerId: "fake", label: "Personal" });
    expect(account).toMatchObject({ providerId: "fake", label: "Personal", supported: true });
    expect(await ai.accountStatus(account.id)).toEqual({ state: "disconnected" });

    expect(await ai.connectAccount(account.id)).toEqual({ state: "connected", identity: "Personal" });

    const renamed = await ai.renameAccount(account.id, "  Home  ");
    expect(renamed).toMatchObject({ id: account.id, label: "Home" });

    await ai.logoutAccount(account.id);
    expect(await ai.accountStatus(account.id)).toEqual({ state: "disconnected" });

    await ai.removeAccount(account.id, { deleteData: true });
    expect(await ai.listAccounts()).toEqual([]);
    await expect(ai.accountStatus(account.id)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("keeps two accounts of one provider isolated", async () => {
    const { ai } = await setup();
    const personal = await connectedAccount(ai, "Personal");
    const work = await ai.createAccount({ providerId: "fake", label: "Work" });

    expect(await ai.accountStatus(personal.id)).toMatchObject({ state: "connected", identity: "Personal" });
    expect(await ai.accountStatus(work.id)).toEqual({ state: "disconnected" });
    await expect(ai.openSession({ accountId: work.id, documentId: "d" })).rejects.toMatchObject({ code: "ACCOUNT_DISCONNECTED" });

    await ai.connectAccount(work.id);
    expect(await ai.accountStatus(work.id)).toMatchObject({ identity: "Work" });
    expect(personal.homeDir).not.toBe(work.homeDir);
  });

  it("refuses a second account when the provider cannot isolate accounts", async () => {
    const { ai } = await setup({ fake: { multiAccount: false } });
    await ai.createAccount({ providerId: "fake" });
    await expect(ai.createAccount({ providerId: "fake" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("reports a failed sign-in without leaving a connected state", async () => {
    const { ai } = await setup({ fake: { env: { FAKE_AI_LOGIN: "fail" } } });
    const account = await ai.createAccount({ providerId: "fake" });
    await expect(ai.connectAccount(account.id)).rejects.toMatchObject({ code: "LOGIN_FAILED" });
    expect(await ai.accountStatus(account.id)).toEqual({ state: "disconnected" });
  });

  it("cancels a sign-in in progress", async () => {
    const { ai } = await setup({ fake: { env: { FAKE_AI_LOGIN: "hang" } } });
    const account = await ai.createAccount({ providerId: "fake" });
    const controller = new AbortController();
    const pending = ai.connectAccount(account.id, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("reports unsupported capabilities instead of simulating them", async () => {
    const { ai } = await setup();
    const account = await connectedAccount(ai);
    await expect(ai.readUsage(account.id)).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED", meta: { capability: "usage" } });
    expect((await ai.listModels(account.id)).map((m) => m.id)).toEqual(["fake-fast", "fake-deep"]);
  });

  it("shares accounts between two applications, but not sessions", async () => {
    const dataDir = await tempDir();
    const slides = createAiCli({ appId: "slides", dataDir, providers: [createFakeProvider()] });
    const graph = createAiCli({ appId: "graph", dataDir, providers: [createFakeProvider()] });
    try {
      const account = await connectedAccount(slides, "Shared");
      expect((await graph.listAccounts()).map((a) => a.label)).toEqual(["Shared"]);
      expect(await graph.accountStatus(account.id)).toMatchObject({ state: "connected" });

      const s1 = await slides.openSession({ accountId: account.id, documentId: "same-name" });
      const s2 = await graph.openSession({ accountId: account.id, documentId: "same-name" });
      await s1.send("one");
      const events: string[] = [];
      s2.on((e) => e.type === "textDelta" && events.push(e.text));
      await s2.send("hello");
      expect(events.join("")).toContain("[history 0,");
      expect(s1.resumeId).not.toBe(s2.resumeId);
    } finally {
      await slides.dispose();
      await graph.dispose();
    }
  });

  it("lists accounts of providers this application does not know", async () => {
    const dataDir = await tempDir();
    const other = createAiCli({ appId: "other", dataDir, providers: [createFakeProvider({ id: "fake2" })] });
    await other.createAccount({ providerId: "fake2", label: "Elsewhere" });
    const { ai } = await setup({ ai: { dataDir } });
    expect(await ai.listAccounts()).toEqual([expect.objectContaining({ label: "Elsewhere", supported: false })]);
  });

  it("keeps credentials out of the registry and the diagnostic report", async () => {
    const { ai, dataDir } = await setup();
    const account = await connectedAccount(ai);
    const registry = await readFile(join(dataDir, "ai", "registry.json"), "utf8");
    expect(registry).not.toMatch(/fake-token/);
    const auth = await readFile(join(account.homeDir, "auth.json"), "utf8");
    expect(auth).toMatch(/fake-token/);

    const report = await ai.diagnosticReport();
    expect(JSON.stringify(report)).not.toMatch(/fake-token/);
    expect(report).toMatchObject({ appId: "test", accounts: { fake: 1 }, providers: [expect.objectContaining({ status: "ready" })] });
  });
});
