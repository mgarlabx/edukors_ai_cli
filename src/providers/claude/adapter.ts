import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CanUseTool, EffortLevel, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AiCliError, toAiCliError } from "../../errors.js";
import type { ScopedLog } from "../../diagnostics.js";
import { createToolMcpServer, TOOL_SERVER_NAME } from "../../mcp/toolServer.js";
import { listSkills } from "../../skills.js";

const PLUGIN_NAME = "edukors";

/**
 * The application's skills as a local Claude Code plugin, made in the
 * session's work dir: a manifest and a link to the skills folder. Returns the
 * plugin's path and the ids that enable those skills, and only those.
 */
function skillsPlugin(workDir: string, skillsDir: string): { path: string; ids: string[] } {
  const path = join(workDir, ".edukors-plugin");
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, ".claude-plugin"), { recursive: true });
  writeFileSync(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN_NAME, description: "Skills offered by the EDUKORS application." }) + "\n");
  // A junction on Windows needs no privileges; elsewhere the type is ignored.
  symlinkSync(skillsDir, join(path, "skills"), "junction");
  const ids = new Set<string>();
  for (const skill of listSkills(skillsDir)) {
    ids.add(`${PLUGIN_NAME}:${skill.folder}`);
    ids.add(`${PLUGIN_NAME}:${skill.name}`);
  }
  return { path, ids: [...ids] };
}
import { compareVersions, findExecutable, readVersion } from "../../platform/discovery.js";
import { buildEnv } from "../../platform/env.js";
import { runLoginCommand } from "../../platform/login.js";
import { runCommand } from "../../platform/process.js";
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
import { interpret } from "./events.js";

/**
 * Claude Code, through the Claude Agent SDK driving the user's own `claude`.
 *
 * Each account is a Claude Code configuration directory of its own
 * (CLAUDE_CONFIG_DIR, the account's managed home). Claude Code keys its
 * macOS Keychain entry by that directory, which is what isolates accounts;
 * this is to be confirmed with live accounts (docs/compatibility.md).
 *
 * The session gets the application's tools (in-process MCP server) and
 * AskUserQuestion, nothing else by default: no shell, no files, no personal
 * settings, skills or MCP servers.
 */

export interface ClaudeProviderOptions {
  /** Absolute path to `claude`, from advanced settings. */
  executable?: string;
  minVersion?: string;
  /** Claude Code's built-in tools offered besides the application's. */
  builtInTools?: string[];
  /** Extra variables for the provider process (advanced settings, tests). */
  env?: Record<string, string>;
  /** For tests: an SDK stand-in. */
  loadSdk?: () => Promise<ClaudeSdk>;
  /** For tests: where to look for `claude`. */
  searchEnv?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
}

/** The address `claude auth login` prints for signing in without the browser it tried to open. */
const LOGIN_URL = /https:\/\/\S+\/oauth\/authorize\S*/;

/** Older builds miss parts of the protocol used here (effort, partial messages, auth status). */
const MIN_VERSION = "2.1.0";

const loadRealSdk = async (): Promise<ClaudeSdk> => (await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk;

/** An npm install on Windows leaves a .cmd shim; the SDK needs what the shim runs. */
function unshim(path: string): string | null {
  if (!path.toLowerCase().endsWith(".cmd")) return path;
  const pkg = join(dirname(path), "node_modules", "@anthropic-ai", "claude-code");
  return [join(pkg, "bin", "claude.exe"), join(pkg, "cli.js")].find((p) => existsSync(p)) ?? null;
}

const AuthStatus = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  email: z.string().optional(),
  account: z.looseObject({ email: z.string().optional() }).optional(),
  orgName: z.string().optional(),
});

/** Logged out, Claude Code still reports `tokenSource: "none"`; a source counts only when it names one. */
export function signedIn(account: { email?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string } | null | undefined): boolean {
  if (!account) return false;
  if (account.apiProvider && account.apiProvider !== "firstParty") return true;
  const source = (s: unknown) => typeof s === "string" && s !== "" && s !== "none";
  return Boolean(account.email || account.subscriptionType || source(account.apiKeySource) || source(account.tokenSource));
}

/** The prompt of a streaming query: yields each message sent, and waits in between. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const next = this.waiting.shift();
    if (next) next({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const next of this.waiting.splice(0)) next({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new AiCliError("TIMEOUT", message)), ms)))]).finally(() => clearTimeout(timer));
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ProviderAdapter {
  const minVersion = options.minVersion ?? MIN_VERSION;
  const builtIns = options.builtInTools ?? ["AskUserQuestion"];
  const loadSdk = options.loadSdk ?? loadRealSdk;
  const startupTimeoutMs = options.startupTimeoutMs ?? 60_000;

  const env = (context: AccountContext) =>
    buildEnv({
      // Extra variables first: they can never replace the account's directory.
      set: {
        ...options.env,
        CLAUDE_CONFIG_DIR: context.homeDir,
        CLAUDE_AGENT_SDK_CLIENT_APP: "edukors-ai-cli",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_ENABLE_TASKS: "0",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        MAX_MCP_OUTPUT_TOKENS: "60000",
      },
    });

  const cli = (context: AccountContext, args: string[], timeoutMs = 20_000) =>
    runCommand({ file: context.detection.executable!, args, env: env(context), timeoutMs, ...(context.signal ? { signal: context.signal } : {}) });

  const capabilities: Capabilities = {
    login: "browser",
    accountStatus: true,
    // Expected from the per-directory Keychain entry; verified with live accounts before release.
    multiAccount: true,
    logout: true,
    persistentSessions: true,
    models: true,
    efforts: true,
    usage: false,
    tools: true,
    questions: builtIns.includes("AskUserQuestion"),
    liveOptions: true,
  };

  /** A query with no prompt yet: it starts Claude Code and initializes, without a model call. */
  async function initialize(context: AccountContext) {
    const sdk = await loadSdk();
    const inbox = new Inbox();
    const q = sdk.query({
      prompt: inbox,
      options: { cwd: context.homeDir, settingSources: [], strictMcpConfig: true, persistSession: false, env: env(context), pathToClaudeCodeExecutable: context.detection.executable! },
    });
    try {
      return await withTimeout(q.initializationResult(), startupTimeoutMs, "Claude Code did not start in time");
    } finally {
      inbox.close();
      q.close();
    }
  }

  return {
    id: "claude",
    displayName: "Claude",
    installUrl: "https://claude.com/claude-code",

    async detect(log): Promise<Detection> {
      const found = await findExecutable({
        names: ["claude"],
        envVar: "EDUKORS_CLAUDE",
        ...(options.executable ? { override: options.executable } : {}),
        extraDirs: [join(homedir(), ".claude", "local")],
        ...(options.searchEnv ? { env: options.searchEnv } : {}),
      });
      const path = found ? unshim(found) : null;
      if (!path) return { providerId: "claude", status: "missing" };
      const version = await readVersion(path, ["--version"], buildEnv({ set: { ...options.env } }));
      if (!version) {
        log.warn("could not read the Claude Code version", { path });
        return { providerId: "claude", status: "error", executable: path, detail: "unrecognized version output" };
      }
      if (compareVersions(version, minVersion) < 0) return { providerId: "claude", status: "incompatible", executable: path, version, requiredVersion: minVersion };
      return { providerId: "claude", status: "ready", executable: path, version };
    },

    capabilities: () => capabilities,

    async connectAccount(context): Promise<AccountStatus> {
      // Opens the browser and waits. Without one, the address it prints ends in a
      // code the user pastes; the application relays it to the command's input.
      const result = await runLoginCommand({ file: context.detection.executable!, args: ["auth", "login", "--claudeai"], env: env(context) }, context, { urlPattern: LOGIN_URL, acceptsCode: true });
      if (result.timedOut) throw new AiCliError("TIMEOUT", "sign-in did not finish in time");
      if (result.code !== 0) throw new AiCliError("LOGIN_FAILED", "Claude sign-in failed", { meta: { detail: (result.stderr.trim() || result.stdout.trim()).slice(-300) } });
      return this.accountStatus(context);
    },

    async accountStatus(context): Promise<AccountStatus> {
      // Exits 1 when signed out, still printing the JSON.
      const result = await cli(context, ["auth", "status", "--json"]);
      let parsed: z.infer<typeof AuthStatus>;
      try {
        parsed = AuthStatus.parse(JSON.parse(result.stdout));
      } catch (e) {
        throw new AiCliError("PROVIDER_PROTOCOL", "unexpected output from claude auth status", { cause: e, meta: { code: result.code } });
      }
      if (!parsed.loggedIn) return { state: "disconnected" };
      const identity = parsed.email ?? parsed.account?.email ?? parsed.orgName;
      return { state: "connected", ...(identity ? { identity } : {}) };
    },

    async logout(context) {
      const result = await cli(context, ["auth", "logout"]);
      if (result.code !== 0) throw new AiCliError("PROVIDER_ERROR", "Claude sign-out failed", { meta: { detail: result.stderr.trim().slice(-300) } });
    },

    async listModels(context): Promise<ModelInfo[]> {
      const init = await initialize(context);
      return init.models.map((m) => ({
        id: m.value,
        label: m.displayName,
        ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
        ...(m.value === "default" ? { default: true } : {}),
      }));
    },

    openSession: async (context, hooks) => ClaudeSession.open(await loadSdk(), context, hooks, { env: env(context), builtIns, startupTimeoutMs }),
  };
}

interface Pending {
  requestId: string;
  sink: TurnSink;
  /** A failure Claude reported during the turn, used if the turn then fails. */
  error: AiCliError | null;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: Error) => void;
}

class ClaudeSession implements ProviderSession {
  resumeId: string | undefined;
  private pending: Pending | null = null;
  private closing = false;
  private pump: Promise<void> = Promise.resolve();

  private constructor(
    private readonly q: Query,
    private readonly inbox: Inbox,
    private readonly log: ScopedLog,
    private readonly hooks: SessionHooks,
    sessionId: string,
  ) {
    this.resumeId = sessionId;
  }

  static async open(sdk: ClaudeSdk, context: SessionContext, hooks: SessionHooks, opts: { env: Record<string, string>; builtIns: string[]; startupTimeoutMs: number }): Promise<ClaudeSession> {
    const sessionId = context.resumeId ?? randomUUID();
    const inbox = new Inbox();
    let session: ClaudeSession | null = null;
    const idle = Promise.resolve({ content: "No request is active.", isError: true });
    // In-process MCP servers: the application's tools, and each of the user's servers through the core.
    const servers: NonNullable<Options["mcpServers"]> = {};
    if (context.tools.length) {
      const instance = createToolMcpServer(context.tools, (name, args) => (session?.pending ? session.pending.sink.callTool(name, args) : idle));
      servers[TOOL_SERVER_NAME] = { type: "sdk", name: TOOL_SERVER_NAME, instance };
    }
    for (const external of context.externalServers) {
      const instance = createToolMcpServer(external.tools, (name, args) => (session?.pending ? session.pending.sink.callExternal(external.name, name, args) : idle), external.name);
      servers[external.name] = { type: "sdk", name: external.name, instance };
    }
    const plugin = context.skillsDir ? skillsPlugin(context.workDir, context.skillsDir) : null;
    const served = Object.keys(servers);

    // The one place that decides. The application's tools validate themselves and the
    // user's servers are authorized by the core; loading a skill only reads its text.
    const canUseTool: CanUseTool = async (toolName, input) => {
      if (served.some((name) => toolName.startsWith(`mcp__${name}__`))) return { behavior: "allow", updatedInput: input };
      if (toolName === "Skill" && plugin) return { behavior: "allow", updatedInput: input };
      if (toolName === "AskUserQuestion") return session ? session.answerQuestions(input) : { behavior: "deny", message: "No request is active." };
      return { behavior: "deny", message: "This tool is not available here." };
    };

    const q = sdk.query({
      prompt: inbox,
      options: {
        cwd: context.workDir,
        ...(context.resumeId ? { resume: context.resumeId } : { sessionId }),
        ...(context.options.model ? { model: context.options.model } : {}),
        ...(context.options.effort ? { effort: context.options.effort as EffortLevel } : {}),
        ...(context.instructions ? { systemPrompt: context.instructions } : {}),
        tools: plugin ? [...opts.builtIns, "Skill"] : opts.builtIns,
        mcpServers: servers,
        ...(plugin ? { plugins: [{ type: "local" as const, path: plugin.path }], skills: plugin.ids } : {}),
        strictMcpConfig: true,
        settingSources: [],
        canUseTool,
        includePartialMessages: true,
        persistSession: true,
        env: opts.env,
        pathToClaudeCodeExecutable: context.detection.executable!,
        stderr: (text) => context.log.debug(`claude: ${text.trimEnd()}`),
      },
    });
    session = new ClaudeSession(q, inbox, context.log, hooks, sessionId);
    session.pump = session.run();

    try {
      const init = await withTimeout(q.initializationResult(), opts.startupTimeoutMs, "Claude Code did not start in time");
      if (!signedIn(init.account)) throw new AiCliError("ACCOUNT_DISCONNECTED", "Claude is not signed in on this account");
    } catch (e) {
      await session.close();
      throw toAiCliError(e, "PROVIDER_START_FAILED");
    }
    return session;
  }

  send(input: TurnInput, sink: TurnSink): Promise<TurnOutcome> {
    if (this.pending) return Promise.reject(new AiCliError("SESSION_BUSY", "a turn is already running"));
    if (this.closing) return Promise.reject(new AiCliError("SESSION_CLOSED", "the session is closed"));
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.pending = { requestId: input.requestId, sink, error: null, resolve, reject };
      const text = input.context ? `${input.text}\n\n<document>\n${input.context}\n</document>` : input.text;
      this.inbox.push({ type: "user", uuid: input.requestId as SDKUserMessage["uuid"], session_id: this.resumeId ?? "", parent_tool_use_id: null, message: { role: "user", content: text } });
    });
  }

  async interrupt(): Promise<void> {
    if (this.pending) await this.q.interrupt();
  }

  async updateOptions(options: SessionOptions): Promise<void> {
    if (options.model !== undefined) await this.q.setModel(options.model || undefined);
    if (options.effort !== undefined) await this.q.applyFlagSettings({ effortLevel: (options.effort || null) as EffortLevel | null });
  }

  async close(): Promise<void> {
    if (this.closing) return this.pump;
    this.closing = true;
    this.inbox.close();
    try {
      this.q.close();
    } catch (e) {
      this.log.debug("claude close", e);
    }
    await withTimeout(this.pump, 10_000, "Claude Code did not stop in time").catch((e) => this.log.warn("claude did not stop", e));
    this.settle((p) => p.reject(new AiCliError("SESSION_CLOSED", "the session was closed")));
  }

  /** Claude Code's own question tool: each question goes to the user, and the answers back as its input. */
  private async answerQuestions(input: Record<string, unknown>) {
    const pending = this.pending;
    if (!pending) return { behavior: "deny" as const, message: "No request is active." };
    const questions = Array.isArray(input.questions) ? (input.questions as { question?: unknown; options?: { label?: unknown }[] }[]) : [];
    const answers: Record<string, string> = {};
    try {
      for (const q of questions) {
        const prompt = String(q.question ?? "");
        if (!prompt) continue;
        const options = (q.options ?? []).map((o) => String(o.label ?? "")).filter(Boolean);
        answers[prompt] = await pending.sink.ask({ prompt, ...(options.length ? { options } : {}) });
      }
    } catch {
      return { behavior: "deny" as const, message: "The user did not answer." };
    }
    return { behavior: "allow" as const, updatedInput: { ...input, answers } };
  }

  private async run(): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (e) {
      failure = e;
    }
    if (this.closing) return;
    const error = new AiCliError("PROVIDER_CRASHED", "Claude Code stopped unexpectedly", { cause: failure ?? undefined });
    this.hooks.exited(error);
    this.settle((p) => p.reject(error));
  }

  private handle(msg: SDKMessage): void {
    for (const action of interpret(msg)) {
      if (action.kind === "sessionId") {
        this.resumeId = action.id;
        continue;
      }
      const pending = this.pending;
      if (!pending) continue;
      switch (action.kind) {
        case "text":
          pending.sink.text(action.text);
          break;
        case "activity":
          pending.sink.activity(action.phase);
          break;
        case "usage":
          pending.sink.usage(action.usage);
          break;
        case "error":
          pending.error = action.error;
          break;
        case "end":
          this.settle((p) => (p.error && action.outcome === "completed" && p.error.code !== "PROVIDER_ERROR" ? p.reject(p.error) : p.resolve(action.outcome)));
          break;
        case "fail":
          this.settle((p) => p.reject(p.error ?? action.error));
          break;
      }
    }
  }

  private settle(fn: (pending: Pending) => void): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) fn(pending);
  }
}
