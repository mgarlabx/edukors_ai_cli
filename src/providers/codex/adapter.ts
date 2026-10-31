import {PROVIDER_CATALOG} from "../../providerCatalog.js";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AiCliError, toAiCliError } from "../../errors.js";
import { fromWindows, type LimitWindow, type Usage } from "../../events.js";
import type { ScopedLog } from "../../diagnostics.js";
import { startToolBridge, TOOL_SERVER_NAME, type BridgedServer, type ToolBridge } from "../../mcp/toolServer.js";
import { compareVersions, findExecutable, readVersion } from "../../platform/discovery.js";
import { buildEnv } from "../../platform/env.js";
import { runLoginCommand } from "../../platform/login.js";
import { ManagedProcess, runCommand } from "../../platform/process.js";
import { runtimeDirs, sandboxed } from "../../platform/sandbox.js";
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
  Workspace,
} from "../../provider.js";
import { VERSION } from "../../version.js";
import { listSkills, READ_SKILL_TOOL, readSkillFile, readSkillSpec, skillsInstructions } from "../../skills.js";
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
 *
 * In a workspace (macOS only), the app server runs inside the system
 * sandbox (platform/sandbox.ts), which confines Codex and every command it
 * runs to the workspace; Codex is told its commands already run in an
 * external sandbox, since it cannot apply its own inside another.
 */

export interface CodexProviderOptions {
  executable?: string;
  minVersion?: string;
  /** Extra variables for the provider process (advanced settings, tests). */
  env?: Record<string, string>;
  /** For tests: where to look for `codex`. */
  searchEnv?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  /** For tests: the platform the capabilities describe. */
  platform?: NodeJS.Platform;
  /**
   * For tests: runs the app server without the system sandbox. The
   * workspace is then not confined; never set in an application.
   */
  unconfinedWorkspace?: boolean;
}

/** The version this adapter's protocol use was checked against (docs/compatibility.md). */
const MIN_VERSION = "0.164.0";
const TOKEN_VAR = "EDUKORS_MCP_TOKEN";
/** The address `codex login` prints for signing in when the browser does not open. */
const LOGIN_URL = /https:\/\/\S+\/oauth\/authorize\S*/;

const WINDOW_NAMES: Record<number, string> = { 300: "five_hour", 10080: "seven_day" };

/** Every window of every limit, from 0 to 1; the most used one leads. */
export function codexLimits(read: any): Omit<Usage, "observedAt"> | null {
  const snapshots: any[] = read?.rateLimitsByLimitId && typeof read.rateLimitsByLimitId === "object" ? Object.values(read.rateLimitsByLimitId) : read?.rateLimits ? [read.rateLimits] : [];
  const windows: LimitWindow[] = [];
  for (const snap of snapshots)
    for (const [slot, w] of [["primary", snap?.primary], ["secondary", snap?.secondary]] as const) {
      if (!w || typeof w.usedPercent !== "number") continue;
      const span = WINDOW_NAMES[w.windowDurationMins] ?? (w.windowDurationMins ? `${w.windowDurationMins}min` : slot);
      const name = snapshots.length > 1 && snap?.limitId ? `${snap.limitId}:${span}` : span;
      windows.push({ name, used: Math.max(0, Math.min(1, w.usedPercent / 100)), ...(typeof w.resetsAt === "number" ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}) });
    }
  return windows.length ? fromWindows(windows) : null;
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
    // Confinement comes from the macOS sandbox; elsewhere Codex's own cannot keep reads in the workspace.
    workspace: (options.platform ?? process.platform) === "darwin",
    workspaceShell: (options.platform ?? process.platform) === "darwin",
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
    installUrl: PROVIDER_CATALOG[1].url,

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
      // Opens the browser and waits for the ChatGPT sign-in; the address it prints
      // completes in the browser too, so there is no code to paste back.
      const result = await runLoginCommand({ file: context.detection.executable!, args: ["login"], env: env(context) }, context, { urlPattern: LOGIN_URL, acceptsCode: false });
      if (result.timedOut) throw new AiCliError("TIMEOUT", "sign-in did not finish in time");
      if (result.code !== 0) throw new AiCliError("LOGIN_FAILED", "Codex sign-in failed", { meta: { detail: (result.stderr.trim() || result.stdout.trim()).slice(-300) } });
      return this.accountStatus(context);
    },

    async accountStatus(context): Promise<AccountStatus> {
      // The app server names the account (`codex login status` does not); the CLI is the fallback.
      try {
        const read = await withAppServer(context, (rpc) => rpc.request("account/read", { refreshToken: false }, 15_000));
        const account = read?.account;
        if (!account) return { state: "disconnected" };
        const identity = typeof account.email === "string" && account.email ? account.email : account.type === "apiKey" ? "API key" : undefined;
        return { state: "connected", ...(identity ? { identity } : {}) };
      } catch (e) {
        context.log.debug("codex account/read failed; asking the CLI", e);
      }
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

    openSession: (context, hooks) => CodexSession.open(context, hooks, env, startupTimeoutMs, options.unconfinedWorkspace ?? false),
  };
}

/** What the app server reads and writes inside the system sandbox. */
function sandboxPaths(context: SessionContext, workspace: Workspace) {
  // The sandbox sees real paths (on macOS, /var is /private/var).
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const executable = context.detection.executable!;
  return {
    writable: [workspace.dir, real(context.homeDir), real(context.workDir)],
    readable: [...workspace.readDirs, ...(context.skillsDir ? [real(context.skillsDir)] : []), ...runtimeDirs(executable, real(executable))],
    protectedPaths: workspace.protectedPaths,
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

  /** The servers this session serves through its bridge; any other is declined. */
  private bridged = new Set<string>();
  /** Added to Codex's own instructions (unlike baseInstructions, which replaces them). */
  private developerInstructions = "";
  private workspace: Workspace | null = null;

  private constructor(
    private readonly proc: ManagedProcess,
    private readonly bridge: ToolBridge | null,
    private readonly log: ScopedLog,
    private readonly hooks: SessionHooks,
    options: SessionOptions,
  ) {
    this.options = { ...options };
  }

  static async open(
    context: SessionContext,
    hooks: SessionHooks,
    env: (c: AccountContext, extra?: Record<string, string>) => Record<string, string>,
    startupTimeoutMs: number,
    unconfined: boolean,
  ): Promise<CodexSession> {
    let session: CodexSession | null = null;
    const idle = Promise.resolve({ content: "No request is active.", isError: true });
    // Codex reads native skills with shell commands, which an editor session refuses:
    // the application's skills are served by the library instead (read_skill).
    const skills = context.skillsDir ? listSkills(context.skillsDir) : [];
    const ownTools = [...context.tools];
    if (skills.length) {
      if (ownTools.some((t) => t.name === READ_SKILL_TOOL)) context.log.warn(`the application has a tool named ${READ_SKILL_TOOL}; skills are not offered`);
      else ownTools.push(readSkillSpec);
    }
    const callOwn = async (name: string, args: unknown) => {
      const pending = session?.pending;
      if (!pending) return idle;
      if (name !== READ_SKILL_TOOL || !context.skillsDir || ownTools.length === context.tools.length) return pending.sink.callTool(name, args);
      pending.sink.activity("reading");
      const { skill, file } = (args ?? {}) as { skill?: unknown; file?: unknown };
      try {
        return { content: readSkillFile(context.skillsDir, String(skill ?? ""), typeof file === "string" && file ? file : undefined) };
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    };
    // The application's tools and each of the user's servers, all behind the one bridge.
    const served: BridgedServer[] = [
      ...(ownTools.length ? [{ name: TOOL_SERVER_NAME, tools: ownTools, call: callOwn }] : []),
      ...context.externalServers.map((server) => ({
        name: server.name,
        tools: server.tools,
        call: (name: string, args: unknown) => (session?.pending ? session.pending.sink.callExternal(server.name, name, args) : idle),
      })),
    ];
    const bridge = served.length ? await startToolBridge(served, context.log) : null;
    const args = ["app-server"];
    for (const { name } of served)
      args.push("-c", `mcp_servers.${name}.url=${tomlString(bridge!.urlFor(name))}`, "-c", `mcp_servers.${name}.bearer_token_env_var=${tomlString(TOKEN_VAR)}`);
    if (context.workspace) args.push("-c", `web_search=${tomlString(context.workspace.web ? "live" : "disabled")}`);
    const extra: Record<string, string> = bridge ? { [TOKEN_VAR]: bridge.token } : {};
    let command = { file: context.detection.executable!, args };
    if (context.workspace) {
      // Temporary files stay in the session's own scratch space, which the sandbox lets it write.
      const tmp = join(context.workDir, "tmp");
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      Object.assign(extra, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
      if (!unconfined) command = sandboxed(command.file, command.args, sandboxPaths(context, context.workspace));
    }
    const proc = new ManagedProcess({ ...command, env: env(context, extra), cwd: context.workspace?.dir ?? context.workDir });
    session = new CodexSession(proc, bridge, context.log, hooks, context.options);
    session.workspace = context.workspace ?? null;
    session.bridged = new Set(served.map((s) => s.name));
    session.developerInstructions = ownTools.includes(readSkillSpec) ? skillsInstructions(skills) : "";
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
    const cwd = this.workspace?.dir ?? context.workDir;
    await this.disableSkills(cwd);
    const common = {
      // In a workspace with commands, the system sandbox decides: nothing is put to the user.
      approvalPolicy: this.workspace?.shell ? "never" : "untrusted",
      ...(this.workspace ? {} : { sandbox: "read-only" }),
      ...(context.instructions ? { baseInstructions: context.instructions } : {}),
      ...(this.developerInstructions ? { developerInstructions: this.developerInstructions } : {}),
      ...(context.options.model ? { model: context.options.model } : {}),
    };
    const thread = context.resumeId
      ? await this.rpc.request("thread/resume", { threadId: context.resumeId, ...common }, 60_000)
      : await this.rpc.request("thread/start", { cwd, ...common }, 60_000);
    const id = thread?.thread?.id;
    if (typeof id !== "string" || !id) throw new AiCliError("PROVIDER_PROTOCOL", "Codex opened no thread");
    this.resumeId = id;
  }

  /**
   * Codex finds skills on its own (bundled ones, downloaded plugins', the
   * user's ~/.agents) and reads them with shell commands. None belongs in an
   * editor session: every one is switched off, in the account's own config.
   */
  private async disableSkills(cwd: string): Promise<void> {
    try {
      await this.rpc.request("skills/extraRoots/set", { extraRoots: [] }, 30_000);
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
          ...(this.workspace ? { cwd: this.workspace.dir, sandboxPolicy: { type: "externalSandbox", networkAccess: this.workspace.web ? "enabled" : "restricted" } } : {}),
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

  /**
   * The sink for a turn: the current one, or the dead sink of an older turn.
   * A request's turn comes only from `turn/started` or the `turn/start`
   * answer: after a resume, Codex replays notifications of older turns.
   */
  private sinkFor(turnId: unknown): TurnSink | undefined {
    return typeof turnId === "string" ? this.sinks.get(turnId) : undefined;
  }

  private onNotification(method: string, params: any): void {
    if (params?.threadId && params.threadId !== this.resumeId) return;
    const turnId = params?.turnId ?? params?.turn?.id;
    const isCurrent = () => this.pending?.turnId === turnId;
    switch (method) {
      case "turn/started":
        if (typeof turnId === "string") this.adopt(turnId);
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
      case "item/completed": {
        // Codex 0.164 asks the user in an async message and sleeps until a reply steers the turn.
        const item = params?.item;
        if (item?.type === "agentMessage" && Array.isArray(item.questions) && item.questions.length && isCurrent()) void this.answerAsync(turnId, item.questions);
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
      // Without a workspace, no shell and no file writes: declined, and Codex is told so. In a
      // workspace, the system sandbox confines writes, and commands run only when it has them.
      case "item/commandExecution/requestApproval":
        return { decision: this.workspace?.shell ? "accept" : "decline" };
      case "item/fileChange/requestApproval":
        return { decision: this.workspace ? "accept" : "decline" };
      case "execCommandApproval":
        return { decision: this.workspace?.shell ? "approved" : "denied" };
      case "applyPatchApproval":
        return { decision: this.workspace ? "approved" : "denied" };
      case "item/permissions/requestApproval":
        return { permissions: {} };
      // Codex asks before calling an MCP server; the application's tools decide for themselves.
      case "mcpServer/elicitation/request":
        return { action: this.bridged.has(String(params?.serverName)) ? "accept" : "decline" };
      case "item/tool/requestUserInput":
        return this.askUser(params);
      case "item/tool/call":
        return { contentItems: [{ type: "inputText", text: "This tool is not available here." }], success: false };
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  }

  /** Puts an async message's questions to the user and steers the sleeping turn with the answers. */
  private async answerAsync(turnId: string, questions: any[]): Promise<void> {
    const sink = this.sinkFor(turnId);
    if (!sink) return;
    const answers: string[] = [];
    try {
      for (const q of questions) {
        const prompt = String(q?.title ?? "");
        if (!prompt) continue;
        const options = (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean);
        const answer = await sink.ask({ prompt, ...(options.length ? { options } : {}) });
        answers.push(questions.length > 1 ? `${prompt} ${answer}` : answer);
      }
    } catch {
      return; // Cancelled: the interruption ends the turn.
    }
    if (this.pending?.turnId !== turnId || !answers.length) return;
    await this.rpc
      .request("turn/steer", { threadId: this.resumeId, expectedTurnId: turnId, input: [{ type: "text", text: answers.join("\n") }] }, 30_000)
      .catch((e) => this.log.warn("codex did not take the answer", e));
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
