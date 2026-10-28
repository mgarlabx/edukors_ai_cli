import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountRegistry, REGISTRY_SCHEMA_VERSION } from "../src/index.js";
import { withLock } from "../src/registry/lock.js";
import { tempDir } from "./helpers.js";

const record = (id: string) => ({ id, providerId: "fake", label: id, home: `ai/accounts/${id}`, createdAt: "t", updatedAt: "t" });

async function registryIn(dir: string) {
  return new AccountRegistry(join(dir, "ai", "registry.json"), join(dir, "ai", "locks", "registry.lock"));
}

describe("registry", () => {
  it("serializes concurrent writers that share only the file system", async () => {
    const dir = await tempDir();
    // Separate instances share no in-memory mutex, as two applications would.
    const writers = await Promise.all(Array.from({ length: 4 }, () => registryIn(dir)));
    await Promise.all(writers.flatMap((registry, w) => Array.from({ length: 10 }, (_, i) => registry.update((accounts) => void accounts.push(record(`acct-w${w}-${String(i).padStart(3, "0")}`))))));
    const ids = (await writers[0]!.list()).map((a) => a.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    // No temporary files or locks left behind.
    expect((await readdir(join(dir, "ai"))).sort()).toEqual(["locks", "registry.json"]);
    expect(await readdir(join(dir, "ai", "locks"))).toEqual([]);
  });

  it("preserves fields written by a newer compatible version", async () => {
    const dir = await tempDir();
    const registry = await registryIn(dir);
    await mkdir(join(dir, "ai"), { recursive: true });
    await writeFile(registry.file, JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, futureTopLevel: { a: 1 }, accounts: [{ ...record("acct-0001"), color: "blue" }] }));
    await registry.update((accounts) => void (accounts[0]!.label = "Renamed"));
    const saved = JSON.parse(await readFile(registry.file, "utf8"));
    expect(saved.futureTopLevel).toEqual({ a: 1 });
    expect(saved.accounts[0]).toMatchObject({ label: "Renamed", color: "blue" });
  });

  it("reads but never rewrites a newer schema, and refuses one it cannot read", async () => {
    const dir = await tempDir();
    const registry = await registryIn(dir);
    await mkdir(join(dir, "ai"), { recursive: true });
    const newer = { schemaVersion: REGISTRY_SCHEMA_VERSION + 1, minReaderVersion: 1, accounts: [record("acct-0001")] };
    await writeFile(registry.file, JSON.stringify(newer));
    expect(await registry.list()).toHaveLength(1);
    await expect(registry.update(() => undefined)).rejects.toMatchObject({ code: "REGISTRY_TOO_NEW" });
    expect(JSON.parse(await readFile(registry.file, "utf8"))).toEqual(newer);

    await writeFile(registry.file, JSON.stringify({ ...newer, minReaderVersion: REGISTRY_SCHEMA_VERSION + 1 }));
    await expect(registry.list()).rejects.toMatchObject({ code: "REGISTRY_TOO_NEW" });
  });

  it("reports a corrupt registry instead of overwriting it", async () => {
    const dir = await tempDir();
    const registry = await registryIn(dir);
    await mkdir(join(dir, "ai"), { recursive: true });
    await writeFile(registry.file, "{ not json");
    await expect(registry.list()).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    await expect(registry.update(() => undefined)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
    expect(await readFile(registry.file, "utf8")).toBe("{ not json");
  });

  it("takes over a lock left by a process that is gone", async () => {
    const dir = await tempDir();
    const lock = join(dir, "x.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999_999, host: hostname() }));
    expect(await withLock(lock, async () => "ok", { timeoutMs: 1_000 })).toBe("ok");
  });

  it("takes over a lock that stopped being refreshed, and times out on a live one", async () => {
    const dir = await tempDir();
    const stale = join(dir, "stale.lock");
    await mkdir(stale);
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    expect(await withLock(stale, async () => "ok", { timeoutMs: 1_000 })).toBe("ok");

    const busy = join(dir, "busy.lock");
    let release!: () => void;
    const held = withLock(busy, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 20));
    await expect(withLock(busy, async () => "never", { timeoutMs: 300, staleMs: 400 })).rejects.toMatchObject({ code: "REGISTRY_LOCKED" });
    release();
    await held;
  });
});
