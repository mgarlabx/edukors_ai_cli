import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createAiCli, type AiCli, type AiCliOptions, type AiEvent } from "../src/index.js";
import { createFakeProvider, type FakeProviderOptions } from "../src/testing/index.js";

const cleanup: (() => Promise<void>)[] = [];
const folders: string[] = [];

// Providers first: on Windows a folder in use by a process cannot be removed.
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  while (folders.length) await rm(folders.pop()!, { recursive: true, force: true, maxRetries: 10 });
});

/** A temporary data directory, with a space and non-ASCII characters in its path. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "edukors ai ção-"));
  folders.push(dir);
  return dir;
}

export async function setup(options: { fake?: FakeProviderOptions; ai?: Partial<AiCliOptions> } = {}) {
  const dataDir = options.ai?.dataDir ?? (await tempDir());
  const ai = createAiCli({ appId: "test", providers: [createFakeProvider(options.fake)], dataDir, interruptGraceMs: 400, ...options.ai });
  cleanup.push(() => ai.dispose());
  const events: AiEvent[] = [];
  ai.onEvent((e) => events.push(e));
  return { ai, dataDir, events };
}

/** An account of the fake provider, signed in. */
export async function connectedAccount(ai: AiCli, label = "Personal") {
  const account = await ai.createAccount({ providerId: "fake", label });
  await ai.connectAccount(account.id);
  return account;
}

export const textOf = (events: AiEvent[], requestId?: string) =>
  events
    .filter((e) => e.type === "textDelta" && (!requestId || e.requestId === requestId))
    .map((e) => (e as { text: string }).text)
    .join("");

export const types = (events: AiEvent[], requestId?: string) => events.filter((e) => !requestId || e.requestId === requestId).map((e) => e.type);

export async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
