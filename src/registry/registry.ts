import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AiCliError } from "../errors.js";
import { KeyedMutex, withLock } from "./lock.js";

/**
 * The shared account registry: non-secret account metadata, read and written
 * by every EDUKORS application on this computer, possibly running different
 * library versions.
 *
 * Versioning: `schemaVersion` is the format the file was last written in;
 * `minReaderVersion` is the oldest library format that can still read it.
 * A library reads a file whose `minReaderVersion` it meets, and writes only
 * a file whose `schemaVersion` it knows, so an older application never
 * rewrites a newer file. Unknown fields are preserved on write.
 */

export const REGISTRY_SCHEMA_VERSION = 1;

export const AccountRecordSchema = z.looseObject({
  /** Immutable; session identity derives from it, never from the label. */
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  providerId: z.string().min(1),
  label: z.string().min(1).max(80),
  /** Application-managed storage, relative to the data directory. */
  home: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AccountRecord = z.infer<typeof AccountRecordSchema>;

const RegistryFileSchema = z.looseObject({
  schemaVersion: z.number().int().positive(),
  minReaderVersion: z.number().int().positive(),
  accounts: z.array(AccountRecordSchema),
});

type RegistryFile = z.infer<typeof RegistryFileSchema>;

const empty = (): RegistryFile => ({ schemaVersion: REGISTRY_SCHEMA_VERSION, minReaderVersion: 1, accounts: [] });

export class AccountRegistry {
  private readonly mutex = new KeyedMutex();

  constructor(
    readonly file: string,
    private readonly lockDir: string,
  ) {}

  async list(): Promise<AccountRecord[]> {
    return (await this.read()).accounts;
  }

  async get(id: string): Promise<AccountRecord | undefined> {
    return (await this.list()).find((a) => a.id === id);
  }

  /**
   * Reads, changes and writes the registry under the cross-process lock. `change`
   * mutates the draft; whatever it returns is returned.
   */
  update<T>(change: (accounts: AccountRecord[]) => T): Promise<T> {
    return this.mutex.run("registry", () =>
      withLock(this.lockDir, async () => {
        const current = await this.read();
        if (current.schemaVersion > REGISTRY_SCHEMA_VERSION) {
          throw new AiCliError("REGISTRY_TOO_NEW", "the account registry was written by a newer EDUKORS version", {
            meta: { found: current.schemaVersion, supported: REGISTRY_SCHEMA_VERSION },
          });
        }
        const accounts = current.accounts.map((a) => ({ ...a }));
        const result = change(accounts);
        const next: RegistryFile = { ...current, schemaVersion: REGISTRY_SCHEMA_VERSION, minReaderVersion: Math.max(1, current.minReaderVersion), accounts };
        for (const account of next.accounts) AccountRecordSchema.parse(account);
        await this.write(next);
        return result;
      }),
    );
  }

  private async read(): Promise<RegistryFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new AiCliError("REGISTRY_CORRUPT", "the account registry is not valid JSON", { cause: e, meta: { file: this.file } });
    }
    const version = (json as { minReaderVersion?: unknown })?.minReaderVersion;
    if (typeof version === "number" && version > REGISTRY_SCHEMA_VERSION) {
      throw new AiCliError("REGISTRY_TOO_NEW", "the account registry was written by a newer EDUKORS version", {
        meta: { requires: version, supported: REGISTRY_SCHEMA_VERSION },
      });
    }
    const parsed = RegistryFileSchema.safeParse(json);
    if (!parsed.success) throw new AiCliError("REGISTRY_CORRUPT", "the account registry has an invalid structure", { meta: { file: this.file, issue: z.prettifyError(parsed.error) } });
    return parsed.data;
  }

  /** Write to a temporary file, flush, then rename over the original. */
  private async write(data: RegistryFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
}
