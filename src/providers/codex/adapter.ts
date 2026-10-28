import { AiCliError, toAiCliError } from "../../errors.js";
import type { Usage } from "../../events.js";
import type { ScopedLog } from "../../diagnostics.js";
import { startToolBridge, TOOL_SERVER_NAME, type ToolBridge } from "../../mcp/toolServer.js";
import { compareVersions, findExecutable, readVersion } from "../../platform/discovery.js";
import { buildEnv } from "../../platform/env.js";
import { ManagedProcess, runCommand } from "../../platform/process.js";
import type {
  AccountContext,
  AccountStatus,
  Capabilities,
  Detection,
  ModelInfo,
  ProviderAdapter,
  ProviderSession,
  SessionContext,
  SessionHooks,
  SessionOptions,
  TurnInput,
  TurnOutcome,
  TurnSink,
} from "../../provider.js";
import { VERSION } from "../../version.js";
import { attachRpc, type Rpc } from "./rpc.js";

/**
 * OpenAI Codex, through its app server (`codex app-server`): JSON-RPC over
 * stdio, the interface Codex's own editor extensions use.
 *
 * Each account is a Codex home of its own (CODEX_HOME, the account's managed
 * home), where Codex keeps its sign-in. The user's own ~/.codex is never read
 * or copied. The application's tools reach Codex as an MCP server on
 * 127.0.0.1 (agent bridge), given on the command line with `-c` so that two
 * documents on the same account never share or rewrite a config file; the
 * bridge token travels in the environment, not in argv.
 */

export interface CodexProviderOptions {
  executable?: string;
  minVersion?: string;
  /** Extra variables for the provider process (advanced settings, tests). */
  env?: Record<string, string>;
  /** For tests: where to look for `codex`. */
  searchEnv?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

/** The version this adapter's protocol use was checked against (docs/compatibility.md). */
const MIN_VERSION = "0.164.0";
const TOKEN_VAR = "EDUKORS_MCP_TOKEN";

/** The share of the most used window of each limit, from 0 to 1, and when it resets. */
export function codexLimits(read: any): Omit<Usage, "observedAt"> | null {
  const snapshots: any[] = read?.rateLimitsByLimitId && typeof read.rateLimitsByLimitId === "object" ? Object.values(read.rateLimitsByLimitId) : read?.rateLimits ? [read.rateLimits] : [];
  let worst: { used: number; resetsAt?: number } | null = null;
  for (const snap of snapshots)
    for (const w of [snap?.primary, snap?.secondary]) {
      if (!w || typeof w.usedPercent !== "number") continue;
      if (!worst || w.usedPercent > worst.used) worst = { used: w.usedPercent, ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}) };
    }
  if (!worst) return null;
  return { limitUsed: Math.max(0, Math.min(1, worst.used / 100)), ...(worst.resetsAt ? { limitResetsAt: new Date(worst.resetsAt * 1000).toISOString() } : {}) };
}

/** Codex's turn errors, as stable codes. */
export function codexError(error: any): AiCliError {
  const info = error?.codexErrorInfo;
  const kind = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const meta = { providerCode: kind ?? "unknown", detail: String(error?.message ?? "").slice(0, 300) };
  switch (kind) {
    case "usageLimitExceeded":
    case "rateLimitExceeded":
      return new AiCliError("RATE_LIMITED", "Codex's usage limit was reached", { meta });
    case "unauthorized":
      return new AiCliError("ACCOUNT_EXPIRED", "Codex needs to be signed in again", { meta });
    case "serverOverloaded":
    case "internalServerError":
    case "httpConnectionFailed":
      return new AiCliError("PROVIDER_ERROR", "Codex is temporarily unavailable", { meta, retryable: true });
    default:
      return new AiCliError("PROVIDER_ERROR", "Codex could not complete the request", { meta });
  }
}

const tomlString = (value: string) => JSON.stringify(value);

export function createCodexProvider(options: CodexProviderOptions = {}): ProviderAdapter {
  const minVersion = options.minVersion ?? MIN_VERSION;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const env = (context: AccountContext, extra: Record<string, string> = {}) => buildEnv({ set: { ...options.env, CODEX_HOME: context.homeDir, ...extra } });
  const cli = (context: AccountContext, args: string[], timeoutMs = 20_000) =>
    runCommand({ file: context.detection.executable!, args, env: env(context), timeoutMs, ...(context.signal ? { signal: context.signal } : {}) });

  const capabilities: Capabilities = {
    login: "browser",
    accountStatus: true,
    // Expected from CODEX_HOME holding auth.json; verified with live accounts before release.
    multiAccount: true,
    logout: true,
    persistentSessions: true,
    models: true,
    efforts: true,
    usage: true,
    tools: true,
    questions: true,
    liveOptions: true,
  };

  /** A short-lived app server, for questions that need no conversation. */
  async function withAppServer<T>(context: AccountContext, fn: (rpc: Rpc) => Promise<T>): Promise<T> {
    const proc = new ManagedProcess({ file: context.detection.executable!, args: ["app-server"], env: env(context), cwd: context.homeDir });
    try {
      const rpc = attachRpc(proc, {}, context.log);
      await initialize(rpc, startupTimeoutMs);
      return await fn(rpc);
    } catch (e) {
      throw toAiCliError(e, "PROVIDER_ERROR");
    } finally {
      await proc.terminate(1_000);
    }
  }

  return {
    id: "codex",
    displayName: "Codex",
    installUrl: "https://developers.openai.com/codex/cli/",

    async detect(log): Promise<Detection> {
      const path = await findExecutable({
        names: ["codex"],
        envVar: "EDUKORS_CODEX",
        ...(options.executable ? { override: options.executable } : {}),
        ...(options.searchEnv ? { env: options.searchEnv } : {}),
      });
      if (!path) return { providerId: "codex", status: "missing" };
      const version = await readVersion(path, ["--version"], buildEnv({ set: { ...options.env } }));
      if (!version) {
        log.warn("could not read the Codex version", { path });
        return { providerId: "codex", status: "error", executable: path, detail: "unrecognized version output" };
      }
      if (compareVersions(version, minVersion) < 0) return { providerId: "codex", status: "incompatible", executable: path, version, requiredVersion: minVersion };
      return { providerId: "codex", status: "ready", executable: path, version };
    },

    capabilities: () => capabilities,

    async connectAccount(context): Promise<AccountStatus> {
      // Opens the browser and waits for the ChatGPT sign-in to finish.
      const result = await cli(context, ["login"], 10 * 60_000);
      if (result.timedOut) throw new AiCliError("TIMEOUT", "sign-in did not finish in time");
      if (result.code !== 0) throw new AiCliError("LOGIN_FAILED", "Codex sign-in failed", { meta: { detail: result.stderr.trim().slice(-300) } });
      return this.accountStatus(context);
    },

    async accountStatus(context): Promise<AccountStatus> {
      const result = await cli(context, ["login", "status"]);
      const said = `${result.stdout}\n${result.stderr}`;
      if (result.code === 0) return { state: "connected" };
      if (/not logged in/i.test(said)) return { state: "disconnected" };
      return { state: "unknown", detail: said.trim().slice(-200) };
    },

    async logout(context) {
      const result = await cli(context, ["logout"]);
      if (result.code !== 0 && !/not logged in/i.test(result.stdout + result.stderr)) throw new AiCliError("PROVIDER_ERROR", "Codex sign-out failed");
    },

    listModels: (context) =>
      withAppServer(context, async (rpc) => {
        const list = await rpc.request("model/list", { limit: 50 }, 30_000);
        const items: any[] = Array.isArray(list?.data) ? list.data : [];
        return items
          .filter((m) => !m?.hidden && (m?.id || m?.model))
          .map((m): ModelInfo => {
            const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: any) => String(e?.reasoningEffort ?? e)).filter(Boolean) : [];
            return { id: String(m.id ?? m.model), label: String(m.displayName ?? m.id ?? m.model), ...(efforts.length ? { efforts } : {}), ...(m.isDefault ? { default: true } : {}) };
          });
      }),

    readUsage: (context) =>
      withAppServer(context, async (rpc) => {
        const limits = codexLimits(await rpc.request("account/rateLimits/read", null, 30_000));
        return limits ? { ...limits, observedAt: new Date().toISOString() } : null;
      }),

    openSession: (context, hooks) => CodexSession.open(context, hooks, env, startupTimeoutMs),
  };
}

async function initialize(rpc: Rpc, timeoutMs: number): Promise<void> {
  await rpc.request("initialize", { clientInfo: { name: "edukors-ai-cli", title: "EDUKORS", version: VERSION }, capabilities: { experimentalApi: true } }, timeoutMs);
  rpc.notify("initialized", {});
}

interface Pending {
  requestId: string;
  turnId: string | null;
  sink: TurnSink;
  error: AiCliError | null;
  thinking: boolean;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: Error) => void;
}

class CodexSession implements ProviderSession {
  resumeId: string | undefined;
  private rpc!: Rpc;
  private pending: Pending | null = null;
  /** Sinks of recent turns by Codex turn id: late output goes to its own (dead) sink. */
  private readonly sinks = new Map<string, TurnSink>();
  private options: SessionOptions;
  private closing = false;

  private constructor(
    private readonly proc: ManagedProcess,
    private readonly bridge: ToolBridge | null,
    private readonly log: ScopedLog,
    private readonly hooks: SessionHooks,
    options: SessionOptions,
  ) {
    this.options = { ...options };
  }

  static async open(context: SessionContext, hooks: SessionHooks, env: (c: AccountContext, extra?: Record<string, string>) => Record<string, string>, startupTimeoutMs: number): Promise<CodexSession> {
    let session: CodexSession | null = null;
    const bridge = context.tools.length
      ? await startToolBridge(context.tools, (name, args) => (session?.pending ? session.pending.sink.callTool(name, args) : Promise.resolve({ content: "No request is active.", isError: true })), context.log)
      : null;
    const args = ["app-server"];
    if (bridge) args.push("-c", `mcp_servers.${TOOL_SERVER_NAME}.url=${tomlString(bridge.url)}`, "-c", `mcp_servers.${TOOL_SERVER_NAME}.bearer_token_env_var=${tomlString(TOKEN_VAR)}`);
    const proc = new ManagedProcess({ file: context.detection.executable!, args, env: env(context, bridge ? { [TOKEN_VAR]: bridge.token } : {}), cwd: context.workDir });
    session = new CodexSession(proc, bridge, context.log, hooks, context.options);
    try {
      await session.start(context, startupTimeoutMs);
    } catch (e) {
      await session.close();
      const error = toAiCliError(e, "PROVIDER_START_FAILED");
      if (error.code === "PROVIDER_CRASHED") throw new AiCliError("PROVIDER_START_FAILED", "Codex exited during startup", { meta: { stderr: proc.stderr.toString().slice(-300) } });
      throw error;
    }
    void proc.exited.then((info) => session!.exited(info.code, info.signal));
    return session;
  }

  private async start(context: SessionContext, timeoutMs: number): Promise<void> {
    this.rpc = attachRpc(this.proc, { onNotification: (m, p) => this.onNotification(m, p), onRequest: (m, p) => this.onRequest(m, p) }, this.log);
    await initialize(this.rpc, timeoutMs);
    const read = await this.rpc.request("account/read", { refreshToken: false }, timeoutMs);
    if (!read?.account) throw new AiCliError("ACCOUNT_DISCONNECTED", "Codex is not signed in on this account");
    await this.disableSkills(context.workDir);
    const common = {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      ...(context.instructions ? { baseInstructions: context.instructions } : {}),
      ...(context.options.model ? { model: context.options.model } : {}),
    };
    const thread = context.resumeId
      ? await this.rpc.request("thread/resume", { threadId: context.resumeId, ...common }, 60_000)
      : await this.rpc.request("thread/start", { cwd: context.workDir, ...common }, 60_000);
    const id = thread?.thread?.id;
    if (typeof id !== "string" || !id) throw new AiCliError("PROVIDER_PROTOCOL", "Codex opened no thread");
    this.resumeId = id;
  }

  /**
   * Codex finds skills on its own (bundled ones and the user's ~/.agents);
   * none belongs in an editor session. The switch is written to the
   * account's own config, never the user's.
   */
  private async disableSkills(cwd: string): Promise<void> {
    try {
      const list = await this.rpc.request("skills/list", { cwds: [cwd], forceReload: true }, 30_000);
      const skills = (Array.isArray(list?.data) ? list.data : []).flatMap((e: any) => (Array.isArray(e?.skills) ? e.skills : []));
      for (const skill of skills) if (skill?.path && skill.enabled !== false) await this.rpc.request("skills/config/write", { path: String(skill.path), enabled: false }, 30_000);
    } catch (e) {
      this.log.debug("codex skills not adjusted", e);
    }
  }

  async send(input: TurnInput, sink: TurnSink): Promise<TurnOutcome> {
    if (this.pending) throw new AiCliError("SESSION_BUSY", "a turn is already running");
    const text = input.context ? `${input.text}\n\n<document>\n${input.context}\n</document>` : input.text;
    const done = new Promise<TurnOutcome>((resolve, reject) => {
      this.pending = { requestId: input.requestId, turnId: null, sink, error: null, thinking: false, resolve, reject };
    });
    try {
      const started = await this.rpc.request(
        "turn/start",
        {
          threadId: this.resumeId,
          input: [{ type: "text", text }],
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.effort ? { effort: this.options.effort } : {}),
        },
        60_000,
      );
      const turnId = started?.turn?.id;
      // Set by the executor above, which TypeScript does not follow.
      const current = this.pending as Pending | null;
      if (typeof turnId === "string" && current?.requestId === input.requestId) this.adopt(turnId);
    } catch (e) {
      this.settle((p) => p.reject(toAiCliError(e, "PROVIDER_ERROR")));
    }
    return done;
  }

  async interrupt(): Promise<void> {
    const turnId = this.pending?.turnId;
    if (!turnId) return;
    await this.rpc.request("turn/interrupt", { threadId: this.resumeId, turnId }, 30_000).catch((e) => this.log.warn("codex interrupt failed", e));
  }

  /** Model and effort go with each turn, so they apply from the next request. */
  async updateOptions(options: SessionOptions): Promise<void> {
    this.options = { ...this.options, ...options };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.proc.terminate(1_000);
    await this.bridge?.close();
    this.settle((p) => p.reject(new AiCliError("SESSION_CLOSED", "the session was closed")));
  }

  private adopt(turnId: string): void {
    const pending = this.pending;
    if (!pending || pending.turnId) return;
    pending.turnId = turnId;
    this.sinks.set(turnId, pending.sink);
    if (this.sinks.size > 8) this.sinks.delete(this.sinks.keys().next().value!);
  }

  /** The sink for a turn: the current one, or the dead sink of an older turn. */
  private sinkFor(turnId: unknown): TurnSink | undefined {
    if (typeof turnId !== "string") return undefined;
    if (this.pending && !this.pending.turnId && !this.sinks.has(turnId)) this.adopt(turnId);
    return this.sinks.get(turnId);
  }

  private onNotification(method: string, params: any): void {
    if (params?.threadId && params.threadId !== this.resumeId) return;
    const turnId = params?.turnId ?? params?.turn?.id;
    const isCurrent = () => this.pending?.turnId === turnId;
    switch (method) {
      case "turn/started":
        this.sinkFor(turnId);
        return;
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") this.sinkFor(turnId)?.text(params.delta);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const sink = this.sinkFor(turnId);
        if (sink && this.pending && isCurrent() && !this.pending.thinking) {
          this.pending.thinking = true;
          sink.activity("thinking");
        }
        return;
      }
      case "item/started": {
        const type = params?.item?.type;
        if (type === "mcpToolCall" || type === "dynamicToolCall") this.sinkFor(turnId)?.activity("applying");
        else if (type === "webSearch") this.sinkFor(turnId)?.activity("researching");
        return;
      }
      case "thread/tokenUsage/updated": {
        const last = params?.tokenUsage?.last;
        if (last) this.sinkFor(turnId)?.usage({ inputTokens: last.inputTokens, outputTokens: last.outputTokens, cachedInputTokens: last.cachedInputTokens });
        return;
      }
      case "account/rateLimits/updated": {
        const limits = codexLimits(params);
        if (limits && this.pending?.turnId) this.sinks.get(this.pending.turnId)?.usage(limits);
        return;
      }
      case "error":
        if (isCurrent() && params?.willRetry === false && this.pending) this.pending.error = codexError(params.error);
        return;
      case "turn/completed": {
        if (!isCurrent()) return;
        const status = params?.turn?.status;
        if (status === "completed") this.settle((p) => p.resolve("completed"));
        else if (status === "interrupted") this.settle((p) => p.resolve("cancelled"));
        else this.settle((p) => p.reject(p.error ?? codexError(params?.turn?.error)));
        return;
      }
    }
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      // No shell and no file writes in an editor session: declined, and Codex is told so.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: "denied" };
      case "item/permissions/requestApproval":
        return { permissions: {} };
      // Codex asks before calling an MCP server; the application's tools decide for themselves.
      case "mcpServer/elicitation/request":
        return { action: params?.serverName === TOOL_SERVER_NAME ? "accept" : "decline" };
      case "item/tool/requestUserInput":
        return this.askUser(params);
      case "item/tool/call":
        return { contentItems: [{ type: "inputText", text: "This tool is not available here." }], success: false };
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  }

  private async askUser(params: any): Promise<unknown> {
    const sink = this.sinkFor(params?.turnId);
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of Array.isArray(params?.questions) ? params.questions : []) {
      const id = String(q?.id ?? "");
      if (!id) continue;
      answers[id] = { answers: [] };
      if (!sink) continue;
      const options = (Array.isArray(q.options) ? q.options : []).map((o: any) => String(o?.label ?? "")).filter(Boolean);
      try {
        const answer = await sink.ask({ prompt: String(q.question ?? q.header ?? ""), ...(options.length ? { options } : {}) });
        answers[id] = { answers: answer ? [answer] : [] };
      } catch {
        break;
      }
    }
    return { answers };
  }

  private exited(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closing) return;
    void this.bridge?.close();
    const error = new AiCliError("PROVIDER_CRASHED", "Codex stopped unexpectedly", { meta: { code, signal, stderr: this.proc.stderr.toString().slice(-300) } });
    this.hooks.exited(error);
    this.settle((p) => p.reject(error));
  }

  private settle(fn: (pending: Pending) => void): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) fn(pending);
  }
}
