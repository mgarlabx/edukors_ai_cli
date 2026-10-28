import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { arch, platform } from "node:os";
import { AiCliError, toAiCliError } from "./errors.js";
import type { AiEvent, AiEventListener, Usage } from "./events.js";
import { Diagnostics, type DiagnosticEntry, type LogSink } from "./diagnostics.js";
import { DataPaths, defaultDataDir } from "./platform/paths.js";
import { AccountRegistry, type AccountRecord } from "./registry/registry.js";
import { KeyedMutex, withLock } from "./registry/lock.js";
import type { AccountContext, AccountStatus, Capabilities, Detection, ModelInfo, ProviderAdapter, SessionOptions } from "./provider.js";
import { AiSession } from "./session.js";
import { assertToolNames, toolSpec, type ToolDefinition } from "./tools.js";
import { redactValue } from "./redact.js";
import { VERSION } from "./version.js";

export interface AiCliOptions {
  /** Identifies the application, e.g. `slides` or `graph`. Namespaces sessions and logs. */
  appId: string;
  providers: ProviderAdapter[];
  /** Defaults to the shared per-OS-user EDUKORS directory. */
  dataDir?: string;
  /** Receives every (already redacted) diagnostic entry. */
  logSink?: LogSink;
  /** How long a provider has to stop after an interruption before it is shut down. */
  interruptGraceMs?: number;
  /** How long a detection result is reused. */
  detectionTtlMs?: number;
  /** How long `connectAccount` waits for another process signing in to the same provider. */
  authLockTimeoutMs?: number;
}

export interface AccountInfo {
  id: string;
  providerId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  /** Absolute path of the account's managed provider directory (advanced settings only). */
  homeDir: string;
  /** False when this application has no adapter for the account's provider. */
  supported: boolean;
}

export interface OpenSessionOptions {
  accountId: string;
  documentId: string;
  instructions?: string;
  tools?: ToolDefinition[];
  options?: SessionOptions;
  /** A provider conversation id saved from a previous session (`session.resumeId`). */
  resumeId?: string;
}

export interface DiagnosticReport {
  library: { name: string; version: string };
  appId: string;
  platform: string;
  arch: string;
  node: string;
  providers: Detection[];
  accounts: Record<string, number>;
  sessions: { id: string; providerId: string; state: string; lateEventsDropped: number }[];
  entries: DiagnosticEntry[];
}

const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class AiCli {
  readonly appId: string;
  readonly paths: DataPaths;
  readonly registry: AccountRegistry;
  readonly diagnostics: Diagnostics;

  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly detections = new Map<string, { at: number; value: Promise<Detection> }>();
  private readonly openSessions = new Map<string, AiSession>();
  private readonly listeners = new Set<AiEventListener>();
  private readonly authMutex = new KeyedMutex();
  private readonly log;
  private seq = 0;
  private disposed = false;

  constructor(private readonly options: AiCliOptions) {
    if (!APP_ID.test(options.appId)) throw new AiCliError("INVALID_ARGUMENT", `invalid appId: ${options.appId}`);
    this.appId = options.appId;
    for (const adapter of options.providers) {
      if (this.adapters.has(adapter.id)) throw new AiCliError("INVALID_ARGUMENT", `duplicate provider: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
    this.paths = new DataPaths(options.dataDir ?? defaultDataDir());
    this.registry = new AccountRegistry(this.paths.registryFile, join(this.paths.locksDir, "registry.lock"));
    this.diagnostics = new Diagnostics(500, options.logSink);
    this.log = this.diagnostics.scoped("core");
  }

  // ----------------------------------------------------------------- providers

  providers(): { id: string; displayName: string; installUrl?: string }[] {
    return [...this.adapters.values()].map((a) => ({ id: a.id, displayName: a.displayName, ...(a.installUrl ? { installUrl: a.installUrl } : {}) }));
  }

  /** Whether a provider's CLI is installed and compatible. Cached; `refresh` re-checks. */
  detect(providerId: string, options: { refresh?: boolean } = {}): Promise<Detection> {
    const adapter = this.adapter(providerId);
    const cached = this.detections.get(providerId);
    const ttl = this.options.detectionTtlMs ?? 60_000;
    if (cached && !options.refresh && Date.now() - cached.at < ttl) return cached.value;
    const log = this.diagnostics.scoped(`provider:${providerId}`);
    const value = adapter.detect(log).catch((e): Detection => {
      log.error("detection failed", e);
      return { providerId, status: "error", detail: e instanceof Error ? e.message : String(e) };
    });
    this.detections.set(providerId, { at: Date.now(), value });
    return value;
  }

  detectAll(options: { refresh?: boolean } = {}): Promise<Detection[]> {
    return Promise.all([...this.adapters.keys()].map((id) => this.detect(id, options)));
  }

  async capabilities(providerId: string): Promise<Capabilities> {
    return this.adapter(providerId).capabilities(await this.detect(providerId));
  }

  // ------------------------------------------------------------------ accounts

  async listAccounts(): Promise<AccountInfo[]> {
    return (await this.registry.list()).map((a) => this.accountInfo(a));
  }

  async createAccount(input: { providerId: string; label?: string }): Promise<AccountInfo> {
    const adapter = this.adapter(input.providerId);
    const caps = await this.capabilities(adapter.id);
    const label = (input.label ?? "").trim() || `${adapter.displayName}`;
    const id = randomBytes(9).toString("base64url");
    const now = new Date().toISOString();
    const record = await this.registry.update((accounts) => {
      if (!caps.multiAccount && accounts.some((a) => a.providerId === adapter.id)) {
        throw new AiCliError("CAPABILITY_UNSUPPORTED", `${adapter.displayName} does not support more than one account here`, { meta: { providerId: adapter.id } });
      }
      const created: AccountRecord = { id, providerId: adapter.id, label: label.slice(0, 80), home: this.paths.accountHomeRelative(id), createdAt: now, updatedAt: now };
      accounts.push(created);
      return created;
    });
    await mkdir(this.paths.resolve(record.home), { recursive: true, mode: 0o700 });
    this.log.info("account created", { accountId: id, providerId: adapter.id });
    return this.accountInfo(record);
  }

  /** Labels are display-only; the account id, and every session, stays the same. */
  async renameAccount(accountId: string, label: string): Promise<AccountInfo> {
    const clean = label.trim();
    if (!clean) throw new AiCliError("INVALID_ARGUMENT", "the label cannot be empty");
    const record = await this.registry.update((accounts) => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) throw new AiCliError("ACCOUNT_NOT_FOUND", "no such account", { meta: { accountId } });
      account.label = clean.slice(0, 80);
      account.updatedAt = new Date().toISOString();
      return { ...account };
    });
    return this.accountInfo(record);
  }

  /**
   * Removes the account from the shared registry, for every EDUKORS
   * application. Sessions this application has open on it are closed.
   * `deleteData` also deletes the account's managed directory; it never
   * touches the user's own provider configuration.
   */
  async removeAccount(accountId: string, options: { deleteData?: boolean } = {}): Promise<void> {
    const record = await this.registry.update((accounts) => {
      const index = accounts.findIndex((a) => a.id === accountId);
      if (index === -1) throw new AiCliError("ACCOUNT_NOT_FOUND", "no such account", { meta: { accountId } });
      return accounts.splice(index, 1)[0]!;
    });
    await Promise.all([...this.openSessions.values()].filter((s) => s.accountId === accountId).map((s) => s.close("accountRemoved")));
    if (options.deleteData) {
      const home = this.paths.resolve(record.home);
      const rel = relative(join(this.paths.root, "ai", "accounts"), home);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new AiCliError("INTERNAL", "refusing to delete outside the managed accounts directory");
      await rm(home, { recursive: true, force: true });
    }
    this.log.info("account removed", { accountId, deleteData: Boolean(options.deleteData) });
  }

  /**
   * Starts the provider's sign-in flow for this account. Sign-ins to the same
   * provider are serialized, in this process and across EDUKORS applications.
   */
  async connectAccount(accountId: string, options: { signal?: AbortSignal } = {}): Promise<AccountStatus> {
    const { adapter, context } = await this.accountContext(accountId, options.signal);
    return this.authMutex.run(adapter.id, () =>
      withLock(join(this.paths.locksDir, `auth-${adapter.id}.lock`), () => this.guard(adapter.connectAccount(context), "LOGIN_FAILED"), {
        timeoutMs: this.options.authLockTimeoutMs ?? 5 * 60_000,
        onTimeout: () => new AiCliError("TIMEOUT", "another EDUKORS application is signing in to this provider", { meta: { providerId: adapter.id } }),
      }),
    );
  }

  async accountStatus(accountId: string, options: { signal?: AbortSignal } = {}): Promise<AccountStatus> {
    const { adapter, context } = await this.accountContext(accountId, options.signal);
    if (!adapter.capabilities(context.detection).accountStatus) return { state: "unknown" };
    return this.guard(adapter.accountStatus(context), "PROVIDER_ERROR");
  }

  /** Signs the account out at the provider. Unlike `removeAccount`, it stays in the registry. */
  async logoutAccount(accountId: string): Promise<void> {
    const { adapter, context } = await this.accountContext(accountId);
    if (!adapter.logout || !adapter.capabilities(context.detection).logout) throw this.unsupported(adapter, "logout");
    await this.authMutex.run(adapter.id, () => this.guard(adapter.logout!(context), "PROVIDER_ERROR"));
  }

  async listModels(accountId: string): Promise<ModelInfo[]> {
    const { adapter, context } = await this.accountContext(accountId);
    if (!adapter.listModels || !adapter.capabilities(context.detection).models) throw this.unsupported(adapter, "models");
    return this.guard(adapter.listModels(context), "PROVIDER_ERROR");
  }

  /** `null` means the provider did not report usage: unknown, not zero. */
  async readUsage(accountId: string): Promise<Usage | null> {
    const { adapter, context } = await this.accountContext(accountId);
    if (!adapter.readUsage || !adapter.capabilities(context.detection).usage) throw this.unsupported(adapter, "usage");
    return this.guard(adapter.readUsage(context), "PROVIDER_ERROR");
  }

  // ------------------------------------------------------------------ sessions

  /**
   * Opens a conversation for one document on one account. Switching accounts
   * means opening a new session: a session id is never reused across accounts.
   */
  async openSession(input: OpenSessionOptions): Promise<AiSession> {
    if (this.disposed) throw new AiCliError("SESSION_CLOSED", "the library has been disposed");
    if (!input.documentId) throw new AiCliError("INVALID_ARGUMENT", "documentId is required");
    const tools = input.tools ?? [];
    try {
      assertToolNames(tools);
    } catch (e) {
      throw toAiCliError(e, "INVALID_ARGUMENT");
    }
    const { adapter, context, account } = await this.accountContext(input.accountId);
    const capabilities = adapter.capabilities(context.detection);
    if (tools.length > 0 && !capabilities.tools) throw this.unsupported(adapter, "tools");

    const sessionId = randomUUID();
    const workDir = this.paths.sessionDir(this.appId, input.documentId, account.id);
    const scope = { appId: this.appId, documentId: input.documentId, accountId: account.id, providerId: adapter.id, sessionId };
    const session: AiSession = new AiSession({
      adapter,
      capabilities,
      scope,
      tools: new Map(tools.map((t) => [t.name, t])),
      options: input.options ?? {},
      log: this.diagnostics.scoped(`session:${sessionId.slice(0, 8)}`),
      interruptGraceMs: this.options.interruptGraceMs ?? 5_000,
      publish: (event) => this.publish(event),
      onClosed: (s) => this.openSessions.delete(s.id),
      context: async () => {
        // Re-read on every (re)start: the account may have been removed or relabelled.
        const fresh = await this.accountContext(account.id);
        await mkdir(workDir, { recursive: true, mode: 0o700 });
        return {
          ...fresh.context,
          appId: this.appId,
          documentId: input.documentId,
          workDir,
          instructions: input.instructions ?? "",
          tools: tools.map(toolSpec),
          options: {},
        };
      },
    });
    this.openSessions.set(sessionId, session);
    try {
      await session.start(input.resumeId);
    } catch (e) {
      // Nothing was started, so there is nothing to close.
      this.openSessions.delete(sessionId);
      throw e;
    }
    return session;
  }

  sessions(): AiSession[] {
    return [...this.openSessions.values()];
  }

  /** Every event of every session of this instance. Returns an unsubscribe function. */
  onEvent(listener: AiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --------------------------------------------------------------- diagnostics

  /** Safe to export: no credentials, no document content. */
  async diagnosticReport(): Promise<DiagnosticReport> {
    const accounts: Record<string, number> = {};
    try {
      for (const a of await this.registry.list()) accounts[a.providerId] = (accounts[a.providerId] ?? 0) + 1;
    } catch (e) {
      this.log.error("could not read the registry", e);
    }
    return redactValue({
      library: { name: "@edukors/ai-cli", version: VERSION },
      appId: this.appId,
      platform: platform(),
      arch: arch(),
      node: process.version,
      providers: await this.detectAll(),
      accounts,
      sessions: this.sessions().map((s) => ({ id: s.id, providerId: s.providerId, state: s.state, lateEventsDropped: s.lateEventsDropped })),
      entries: this.diagnostics.snapshot(),
    }) as DiagnosticReport;
  }

  /** Closes every session and stops every provider process this instance started. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(this.sessions().map((s) => s.close("disposed")));
    this.listeners.clear();
  }

  // ----------------------------------------------------------------- internals

  private adapter(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new AiCliError("PROVIDER_UNKNOWN", `unknown provider: ${providerId}`, { meta: { providerId } });
    return adapter;
  }

  private accountInfo(record: AccountRecord): AccountInfo {
    return {
      id: record.id,
      providerId: record.providerId,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      homeDir: this.paths.resolve(record.home),
      supported: this.adapters.has(record.providerId),
    };
  }

  private async accountContext(accountId: string, signal?: AbortSignal): Promise<{ adapter: ProviderAdapter; account: AccountRecord; context: AccountContext }> {
    const account = await this.registry.get(accountId);
    if (!account) throw new AiCliError("ACCOUNT_NOT_FOUND", "no such account", { meta: { accountId } });
    const adapter = this.adapter(account.providerId);
    const detection = await this.detect(adapter.id);
    if (detection.status === "missing") throw new AiCliError("CLI_MISSING", `${adapter.displayName} is not installed`, { meta: { providerId: adapter.id } });
    if (detection.status === "incompatible") {
      throw new AiCliError("CLI_INCOMPATIBLE", `${adapter.displayName} ${detection.version ?? ""} is not supported`.trim(), {
        meta: { providerId: adapter.id, version: detection.version, required: detection.requiredVersion },
      });
    }
    if (detection.status !== "ready") throw new AiCliError("PROVIDER_ERROR", `${adapter.displayName} could not be checked`, { meta: { providerId: adapter.id, detail: detection.detail } });
    const homeDir = this.paths.resolve(account.home);
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    return {
      adapter,
      account,
      context: {
        accountId: account.id,
        label: account.label,
        homeDir,
        detection,
        log: this.diagnostics.scoped(`provider:${adapter.id}`),
        ...(signal ? { signal } : {}),
      },
    };
  }

  private async guard<T>(work: Promise<T>, fallback: AiCliError["code"]): Promise<T> {
    try {
      return await work;
    } catch (e) {
      const error = toAiCliError(e, fallback);
      this.log.warn(`operation failed: ${error.code}`, { message: error.message, meta: error.meta });
      throw error;
    }
  }

  private unsupported(adapter: ProviderAdapter, capability: string): AiCliError {
    return new AiCliError("CAPABILITY_UNSUPPORTED", `${adapter.displayName} does not support ${capability}`, { meta: { providerId: adapter.id, capability } });
  }

  private publish(partial: Omit<AiEvent, "seq" | "at">): AiEvent {
    const event = { ...partial, seq: ++this.seq, at: new Date().toISOString() } as AiEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        this.log.error("event listener threw", e);
      }
    }
    return event;
  }
}

export const createAiCli = (options: AiCliOptions): AiCli => new AiCli(options);
