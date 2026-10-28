import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AiCliError } from "../errors.js";
import type { ScopedLog } from "../diagnostics.js";
import { buildEnv } from "../platform/env.js";
import { compareVersions } from "../platform/discovery.js";
import { ManagedProcess, readLines, runCommand } from "../platform/process.js";
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
} from "../provider.js";

/**
 * An adapter for fixtures/fake-ai.mjs. It is written the way a real adapter
 * is: detection, sign-in and status through short commands, a long-running
 * process for the session, runtime validation of everything it reads.
 * Applications can use it to test their integration without any account.
 */

export const FAKE_CLI_PATH = fileURLToPath(new URL("../../fixtures/fake-ai.mjs", import.meta.url));

export interface FakeProviderOptions {
  id?: string;
  /** Defaults to running fixtures/fake-ai.mjs with the current Node. */
  command?: { file: string; args: string[] };
  minVersion?: string;
  multiAccount?: boolean;
  /** Whether a workspace may run commands, as on a platform with a sandbox. Default true. */
  workspaceShell?: boolean;
  /** Extra variables for the fake CLI (FAKE_AI_VERSION, FAKE_AI_LOGIN, ...). */
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

const Incoming = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sessionId: z.string(), resumed: z.boolean(), user: z.string(), turns: z.number() }),
  z.object({ type: z.literal("fatal"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("text"), turnId: z.string(), delta: z.string() }),
  z.object({ type: z.literal("activity"), turnId: z.string(), phase: z.enum(["thinking", "reading", "researching", "applying"]) }),
  z.object({ type: z.literal("tool_call"), turnId: z.string(), callId: z.string(), name: z.string(), args: z.unknown() }),
  z.object({ type: z.literal("mcp_call"), turnId: z.string(), callId: z.string(), server: z.string(), name: z.string(), args: z.unknown() }),
  z.object({ type: z.literal("question"), turnId: z.string(), questionId: z.string(), prompt: z.string(), options: z.array(z.string()).optional() }),
  z.object({ type: z.literal("usage"), turnId: z.string(), inputTokens: z.number(), outputTokens: z.number() }),
  z.object({ type: z.literal("done"), turnId: z.string() }),
  z.object({ type: z.literal("cancelled"), turnId: z.string() }),
  z.object({ type: z.literal("error"), turnId: z.string().optional(), code: z.string(), message: z.string() }),
]);
type Incoming = z.infer<typeof Incoming>;

const StatusOutput = z.object({ signedIn: z.boolean(), user: z.string().optional(), expired: z.boolean().optional() });
const ModelsOutput = z.object({ models: z.array(z.object({ id: z.string(), label: z.string().optional(), efforts: z.array(z.string()).optional(), default: z.boolean().optional() })) });

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  const line = text.trim().split("\n").filter(Boolean).pop() ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (e) {
    throw new AiCliError("PROVIDER_PROTOCOL", `${what}: output is not JSON`, { cause: e });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AiCliError("PROVIDER_PROTOCOL", `${what}: unexpected output`, { meta: { issue: z.prettifyError(parsed.error) } });
  return parsed.data;
}

const errorFromProvider = (code: string, message: string) =>
  code === "rate_limited"
    ? new AiCliError("RATE_LIMITED", message)
    : code === "auth"
      ? new AiCliError("ACCOUNT_DISCONNECTED", message)
      : code === "expired"
        ? new AiCliError("ACCOUNT_EXPIRED", message)
        : new AiCliError("PROVIDER_ERROR", message, { meta: { providerCode: code } });

export function createFakeProvider(options: FakeProviderOptions = {}): ProviderAdapter {
  const id = options.id ?? "fake";
  const command = options.command ?? { file: process.execPath, args: [FAKE_CLI_PATH] };
  const minVersion = options.minVersion ?? "1.0.0";
  const env = (context?: AccountContext) => buildEnv({ set: { ...options.env, ...(context ? { FAKE_AI_HOME: context.homeDir } : {}) } });
  const run = (context: AccountContext, args: string[], timeoutMs = 15_000) =>
    runCommand({ file: command.file, args: [...command.args, ...args], env: env(context), timeoutMs, ...(context.signal ? { signal: context.signal } : {}) });

  const capabilities: Capabilities = {
    login: "browser",
    accountStatus: true,
    multiAccount: options.multiAccount ?? true,
    logout: true,
    persistentSessions: true,
    models: true,
    efforts: true,
    usage: false,
    tools: true,
    questions: true,
    liveOptions: true,
    workspace: true,
    workspaceShell: options.workspaceShell ?? true,
  };

  return {
    id,
    displayName: "Fake AI",
    installUrl: "https://example.invalid/fake-ai",

    async detect(): Promise<Detection> {
      const result = await runCommand({ file: command.file, args: [...command.args, "--version"], env: env(), timeoutMs: 10_000 }).catch(() => null);
      if (!result || result.code !== 0) return { providerId: id, status: "missing" };
      const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (!version) return { providerId: id, status: "error", executable: command.file, detail: "unrecognized version output" };
      if (compareVersions(version, minVersion) < 0) return { providerId: id, status: "incompatible", executable: command.file, version, requiredVersion: minVersion };
      return { providerId: id, status: "ready", executable: command.file, version };
    },

    capabilities: () => capabilities,

    async connectAccount(context): Promise<AccountStatus> {
      const result = await run(context, ["login", "--label", context.label], 120_000);
      if (result.timedOut) throw new AiCliError("TIMEOUT", "sign-in did not finish in time");
      if (result.code !== 0) throw new AiCliError("LOGIN_FAILED", "sign-in failed", { meta: { detail: result.stderr.trim().slice(0, 300) } });
      return this.accountStatus(context);
    },

    async accountStatus(context): Promise<AccountStatus> {
      const result = await run(context, ["status"]);
      if (result.code !== 0) throw new AiCliError("PROVIDER_ERROR", "status check failed", { meta: { detail: result.stderr.trim().slice(0, 300) } });
      const status = parseJson(StatusOutput, result.stdout, "status");
      if (!status.signedIn) return { state: "disconnected" };
      return { state: status.expired ? "expired" : "connected", ...(status.user ? { identity: status.user } : {}) };
    },

    async logout(context) {
      const result = await run(context, ["logout"]);
      if (result.code !== 0) throw new AiCliError("PROVIDER_ERROR", "sign-out failed");
    },

    async listModels(context): Promise<ModelInfo[]> {
      const result = await run(context, ["models"]);
      if (result.code !== 0) throw new AiCliError("PROVIDER_ERROR", "could not list models");
      return parseJson(ModelsOutput, result.stdout, "models").models;
    },

    openSession: (context, hooks) => FakeSession.open(command, env(context), context, hooks, options.startupTimeoutMs ?? 10_000),
  };
}

interface PendingTurn {
  turnId: string;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: Error) => void;
}

class FakeSession implements ProviderSession {
  resumeId: string | undefined;
  private pending: PendingTurn | null = null;
  /**
   * Sinks of recent turns, kept after they end: output that arrives late is
   * still delivered to its sink, which the library then drops. The adapter
   * does not have to get this right for the document to be safe.
   */
  private readonly sinks = new Map<string, TurnSink>();
  private closing = false;

  private constructor(
    private readonly proc: ManagedProcess,
    private readonly log: ScopedLog,
    private readonly hooks: SessionHooks,
  ) {}

  static async open(command: { file: string; args: string[] }, env: Record<string, string>, context: SessionContext, hooks: SessionHooks, startupTimeoutMs: number): Promise<FakeSession> {
    const args = [...command.args, "serve", ...(context.resumeId ? ["--resume", context.resumeId] : [])];
    const proc = new ManagedProcess({ file: command.file, args, env, cwd: context.workspace?.dir ?? context.workDir });
    const session = new FakeSession(proc, context.log, hooks);

    const ready = new Promise<string>((resolve, reject) => {
      session.onStartup = (msg) => {
        if (msg.type === "ready") resolve(msg.sessionId);
        else if (msg.type === "fatal") reject(errorFromProvider(msg.code, msg.message));
      };
      void proc.exited.then((info) =>
        reject(new AiCliError("PROVIDER_START_FAILED", "the provider exited during startup", { meta: { code: info.code, stderr: proc.stderr.toString().slice(-300) } })),
      );
      setTimeout(() => reject(new AiCliError("TIMEOUT", "the provider did not start in time")), startupTimeoutMs).unref();
    });

    readLines(proc.child.stdout, (line) => session.onLine(line), { onOverflow: () => context.log.warn("discarded an oversized line") });
    void proc.exited.then((info) => session.onExit(info.code, info.signal));

    try {
      session.resumeId = await ready;
    } catch (e) {
      session.closing = true;
      await proc.terminate(500);
      throw e;
    }
    session.onStartup = null;
    proc.writeLine({
      type: "init",
      instructions: context.instructions,
      tools: context.tools,
      model: context.options.model,
      effort: context.options.effort,
      ...(context.workspace ? { workspace: context.workspace } : {}),
    });
    return session;
  }

  private onStartup: ((msg: Incoming) => void) | null = null;

  send(input: TurnInput, sink: TurnSink): Promise<TurnOutcome> {
    if (this.pending) return Promise.reject(new AiCliError("SESSION_BUSY", "a turn is already running"));
    const turnId = input.requestId;
    this.sinks.set(turnId, sink);
    if (this.sinks.size > 8) this.sinks.delete(this.sinks.keys().next().value!);
    return new Promise<TurnOutcome>((resolve, reject) => {
      this.pending = { turnId, resolve, reject };
      const text = input.context ? `${input.text}\n\n<document>\n${input.context}\n</document>` : input.text;
      if (!this.proc.writeLine({ type: "turn", turnId, text })) {
        this.pending = null;
        reject(new AiCliError("PROVIDER_CRASHED", "the provider is not running"));
      }
    });
  }

  async interrupt(): Promise<void> {
    if (this.pending) this.proc.writeLine({ type: "interrupt", turnId: this.pending.turnId });
  }

  async updateOptions(options: SessionOptions): Promise<void> {
    this.proc.writeLine({ type: "options", model: options.model, effort: options.effort });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.proc.writeLine({ type: "exit" });
    await this.proc.terminate(1_000);
    this.settle((p) => p.reject(new AiCliError("SESSION_CLOSED", "the session was closed")));
  }

  private settle(fn: (pending: PendingTurn) => void): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) fn(pending);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.log.warn("ignored a line that is not JSON", { line: line.slice(0, 200) });
      return;
    }
    const parsed = Incoming.safeParse(raw);
    if (!parsed.success) {
      this.log.warn("ignored an unexpected message", { issue: z.prettifyError(parsed.error) });
      return;
    }
    const msg = parsed.data;
    if (this.onStartup) return this.onStartup(msg);
    if (msg.type === "ready" || msg.type === "fatal") return;

    const sink = msg.turnId ? this.sinks.get(msg.turnId) : undefined;
    if (!sink) {
      this.log.debug("output for an unknown turn", { type: msg.type });
      return;
    }
    const isCurrent = this.pending?.turnId === msg.turnId;
    switch (msg.type) {
      case "text":
        return sink.text(msg.delta);
      case "activity":
        return sink.activity(msg.phase);
      case "usage":
        return sink.usage({ inputTokens: msg.inputTokens, outputTokens: msg.outputTokens });
      case "tool_call":
        void sink.callTool(msg.name, msg.args).then((result) => this.proc.writeLine({ type: "tool_result", callId: msg.callId, ...result }));
        return;
      case "mcp_call":
        void sink.callExternal(msg.server, msg.name, msg.args).then((result) => this.proc.writeLine({ type: "tool_result", callId: msg.callId, ...result }));
        return;
      case "question":
        sink.ask({ prompt: msg.prompt, ...(msg.options ? { options: msg.options } : {}) }).then(
          (answer) => this.proc.writeLine({ type: "answer", questionId: msg.questionId, answer }),
          () => undefined,
        );
        return;
      case "done":
        if (isCurrent) this.settle((p) => p.resolve("completed"));
        return;
      case "cancelled":
        if (isCurrent) this.settle((p) => p.resolve("cancelled"));
        return;
      case "error":
        if (isCurrent) this.settle((p) => p.reject(errorFromProvider(msg.code, msg.message)));
        return;
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // During startup, `open` reports the failure itself.
    if (this.closing || this.onStartup) return;
    const error = new AiCliError("PROVIDER_CRASHED", "the provider stopped unexpectedly", { meta: { code, signal, stderr: this.proc.stderr.toString().slice(-300) } });
    this.hooks.exited(error);
    this.settle((p) => p.reject(error));
  }
}
