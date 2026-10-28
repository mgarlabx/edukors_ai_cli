import { randomUUID } from "node:crypto";
import { AiCliError, toAiCliError, type SerializedError } from "./errors.js";
import type { AiEvent, AiEventBody, AiEventListener, EventScope, SessionCloseReason } from "./events.js";
import type { ScopedLog } from "./diagnostics.js";
import type { Capabilities, ProviderAdapter, ProviderSession, SessionContext, SessionOptions, TurnOutcome, TurnSink } from "./provider.js";
import type { ToolDefinition, ToolResult } from "./tools.js";

/**
 * One conversation: one application, one document, one account.
 *
 * The session owns the identity rules the plan requires. Every request gets
 * its own sink; once the request is interrupted, finished or replaced, that
 * sink drops whatever the provider still sends, so late output never reaches
 * the document. A provider that crashes is restarted on the next request,
 * resuming its conversation when the provider supports it.
 */

export type SessionState = "opening" | "idle" | "busy" | "interrupting" | "failed" | "closed";

export interface TurnResult {
  requestId: string;
  status: "completed" | "cancelled" | "failed";
  error?: SerializedError;
}

export interface SendOptions {
  /** Supplied by the application to correlate events with its own records. */
  requestId?: string;
  /** Latest document state, including unsaved manual edits. */
  context?: string;
}

interface Turn {
  requestId: string;
  abort: AbortController;
  cancelled: boolean;
  result: TurnResult | null;
  questions: Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>;
  settled: Promise<void>;
  settle: () => void;
}

export interface SessionDeps {
  adapter: ProviderAdapter;
  capabilities: Capabilities;
  scope: Omit<EventScope, "requestId">;
  /** Builds a fresh provider context (account home, work dir, tools). */
  context: () => Promise<SessionContext>;
  tools: ReadonlyMap<string, ToolDefinition>;
  options: SessionOptions;
  publish: (event: Omit<AiEvent, "seq" | "at">) => AiEvent;
  log: ScopedLog;
  interruptGraceMs: number;
  onClosed: (session: AiSession) => void;
}

const settledWithin = (turn: Turn, ms: number) =>
  Promise.race([turn.settled.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms).unref())]);

export class AiSession {
  readonly id: string;
  readonly appId: string;
  readonly documentId: string;
  readonly accountId: string;
  readonly providerId: string;

  private _state: SessionState = "opening";
  private provider: ProviderSession | null = null;
  /** Identifies the current provider instance; hooks from older ones are ignored. */
  private providerToken: object | null = null;
  private _resumeId: string | undefined;
  private turn: Turn | null = null;
  private closing = false;
  private options: SessionOptions;
  private readonly listeners = new Set<AiEventListener>();
  private droppedEvents = 0;

  constructor(private readonly deps: SessionDeps) {
    this.id = deps.scope.sessionId;
    this.appId = deps.scope.appId;
    this.documentId = deps.scope.documentId;
    this.accountId = deps.scope.accountId;
    this.providerId = deps.scope.providerId;
    this.options = { ...deps.options };
  }

  get state(): SessionState {
    return this._state;
  }

  /** The provider's own conversation id, for applications that persist it to resume later. */
  get resumeId(): string | undefined {
    return this._resumeId;
  }

  /** Events of this session only. Returns an unsubscribe function. */
  on(listener: AiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Opens (or reopens) the provider session. Called by the library; reopening happens on demand. */
  async start(resumeId?: string): Promise<void> {
    if (this.closing) throw new AiCliError("SESSION_CLOSED", "the session is closed");
    this._state = "opening";
    const context = await this.deps.context();
    context.options = { ...this.options };
    if (resumeId && this.deps.capabilities.persistentSessions) context.resumeId = resumeId;

    const token = {};
    this.providerToken = token;
    let instance: ProviderSession;
    try {
      instance = await this.deps.adapter.openSession(context, { exited: (error) => this.providerExited(token, error) });
    } catch (e) {
      if (this.providerToken === token) this.providerToken = null;
      this._state = this.closing ? "closed" : "failed";
      throw toAiCliError(e, "PROVIDER_START_FAILED");
    }
    if (this.closing || this.providerToken !== token) {
      await instance.close().catch(() => undefined);
      throw new AiCliError("SESSION_CLOSED", "the session is closed");
    }
    this.provider = instance;
    const resumed = context.resumeId !== undefined && instance.resumeId === context.resumeId;
    this._resumeId = instance.resumeId ?? this._resumeId;
    this._state = "idle";
    this.emit({ type: "sessionOpened", resumed });
  }

  /**
   * Sends a request and resolves when it ends. Failures resolve with
   * `status: "failed"` and are also emitted as `error` events; only misuse
   * (a closed or busy session) rejects.
   */
  async send(text: string, options: SendOptions = {}): Promise<TurnResult> {
    if (this.closing) throw new AiCliError("SESSION_CLOSED", "the session is closed");
    if (this.turn) throw new AiCliError("SESSION_BUSY", "a request is already in progress");
    const turn = this.newTurn(options.requestId ?? randomUUID());
    this.turn = turn;
    this._state = "busy";

    try {
      this.emit({ type: "activity", phase: "preparing" }, turn.requestId);
      if (!this.provider) {
        await this.start(this._resumeId);
        this._state = "busy";
      }
      if (turn.cancelled) return this.finish(turn, "cancelled");
      const provider = this.provider;
      if (!provider) throw new AiCliError("PROVIDER_CRASHED", "the provider stopped before the request started");
      const outcome: TurnOutcome = await provider.send({ requestId: turn.requestId, text, ...(options.context !== undefined ? { context: options.context } : {}) }, this.sinkFor(turn));
      return this.finish(turn, turn.cancelled ? "cancelled" : outcome);
    } catch (e) {
      if (turn.cancelled) return this.finish(turn, "cancelled");
      const error = toAiCliError(e, "PROVIDER_ERROR");
      if (error.code === "PROVIDER_CRASHED" || error.code === "PROVIDER_START_FAILED") this.dropProvider();
      this.deps.log.warn(`request failed: ${error.code}`, { message: error.message, cause: error.cause });
      return this.finish(turn, "failed", error);
    }
  }

  /**
   * Stops the current request. Resolves once it has settled: already
   * committed tool calls stay committed, nothing after this point is applied.
   * A provider that does not stop within the grace period is shut down and
   * restarted (resumed) on the next request.
   */
  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    if (!turn.cancelled) {
      turn.cancelled = true;
      turn.abort.abort();
      if (!this.closing) this._state = "interrupting";
      for (const q of turn.questions.values()) q.reject(new AiCliError("CANCELLED", "the request was cancelled"));
      turn.questions.clear();
      const provider = this.provider;
      provider?.interrupt().catch((e) => this.deps.log.warn("provider interrupt failed", e));
      if (!(await settledWithin(turn, this.deps.interruptGraceMs))) {
        this.deps.log.warn("provider did not stop in time; shutting it down");
        this.dropProvider();
        await provider?.close().catch((e) => this.deps.log.warn("provider close failed", e));
        // A well-behaved adapter settles `send` on close; otherwise settle it here.
        if (!(await settledWithin(turn, this.deps.interruptGraceMs))) this.finish(turn, "cancelled");
      }
    }
    await turn.settled;
  }

  /** Answers a `question` event. */
  answer(questionId: string, answer: string): void {
    const pending = this.turn?.questions.get(questionId);
    if (!pending) throw new AiCliError("QUESTION_NOT_FOUND", "no such question is waiting", { meta: { questionId } });
    this.turn!.questions.delete(questionId);
    pending.resolve(answer);
  }

  async updateOptions(options: SessionOptions): Promise<void> {
    if (this.closing) throw new AiCliError("SESSION_CLOSED", "the session is closed");
    const next = { ...this.options, ...options };
    if (this.provider) {
      if (!this.deps.capabilities.liveOptions || !this.provider.updateOptions) {
        throw new AiCliError("CAPABILITY_UNSUPPORTED", "this provider cannot change options in an open session", { meta: { providerId: this.providerId } });
      }
      await this.provider.updateOptions(next);
    }
    this.options = next;
  }

  async close(reason: SessionCloseReason = "closed"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.interrupt();
    const provider = this.provider;
    this.dropProvider();
    await provider?.close().catch((e) => this.deps.log.warn("provider close failed", e));
    this._state = "closed";
    this.emit({ type: "sessionClosed", reason });
    this.deps.onClosed(this);
  }

  /** Counts provider output that arrived for a request no longer current. */
  get lateEventsDropped(): number {
    return this.droppedEvents;
  }

  // ---------------------------------------------------------------- internals

  private newTurn(requestId: string): Turn {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    return { requestId, abort: new AbortController(), cancelled: false, result: null, questions: new Map(), settled, settle };
  }

  private finish(turn: Turn, status: TurnResult["status"], error?: AiCliError): TurnResult {
    if (turn.result) return turn.result;
    const result: TurnResult = { requestId: turn.requestId, status, ...(error ? { error: error.toJSON() } : {}) };
    turn.result = result;
    for (const q of turn.questions.values()) q.reject(new AiCliError("CANCELLED", "the request ended"));
    turn.questions.clear();
    if (!turn.abort.signal.aborted) turn.abort.abort();
    if (this.turn === turn) this.turn = null;
    if (!this.closing) this._state = status === "failed" && !this.provider ? "failed" : "idle";
    if (status === "completed") this.emit({ type: "turnCompleted" }, turn.requestId);
    else if (status === "cancelled") this.emit({ type: "cancelled" }, turn.requestId);
    else this.emit({ type: "error", error: result.error! }, turn.requestId);
    turn.settle();
    return result;
  }

  private dropProvider(): void {
    this.provider = null;
    this.providerToken = null;
  }

  private providerExited(token: object, error: Error): void {
    if (token !== this.providerToken) return;
    this.dropProvider();
    // During a request the adapter rejects `send`, which reports the failure.
    if (this.turn || this.closing) return;
    this._state = "failed";
    const err = toAiCliError(error, "PROVIDER_CRASHED");
    this.deps.log.warn("provider exited while idle", { code: err.code, message: err.message });
    this.emit({ type: "error", error: err.toJSON() });
  }

  private sinkFor(turn: Turn): TurnSink {
    const live = () => this.turn === turn && !turn.abort.signal.aborted;
    const drop = (what: string) => {
      this.droppedEvents++;
      this.deps.log.debug(`dropped late ${what}`, { requestId: turn.requestId });
    };
    return {
      signal: turn.abort.signal,
      text: (delta) => (live() ? this.emit({ type: "textDelta", text: delta }, turn.requestId) : drop("text")),
      activity: (phase, detail) => (live() ? this.emit({ type: "activity", phase, ...(detail ? { detail } : {}) }, turn.requestId) : drop("activity")),
      usage: (usage) => (live() ? this.emit({ type: "usageUpdated", usage: { ...usage, observedAt: usage.observedAt ?? new Date().toISOString() } }, turn.requestId) : drop("usage")),
      callTool: (name, args) => this.callTool(turn, live, name, args),
      ask: (question) => {
        if (!live()) {
          drop("question");
          return Promise.reject(new AiCliError("CANCELLED", "the request is no longer active"));
        }
        const questionId = randomUUID();
        return new Promise<string>((resolve, reject) => {
          turn.questions.set(questionId, { resolve, reject });
          this.emit({ type: "question", questionId, prompt: question.prompt, ...(question.options ? { options: question.options } : {}) }, turn.requestId);
        });
      },
    };
  }

  private async callTool(turn: Turn, live: () => boolean, name: string, args: unknown): Promise<ToolResult> {
    if (!live()) {
      this.droppedEvents++;
      return { content: "The request was cancelled; the tool was not run.", isError: true };
    }
    const callId = randomUUID();
    const tool = this.deps.tools.get(name);
    this.emit({ type: "toolStarted", callId, tool: name }, turn.requestId);
    const fail = (code: string, message: string): ToolResult => {
      this.emit({ type: "toolCompleted", callId, tool: name, ok: false, errorCode: code }, turn.requestId);
      return { content: message, isError: true };
    };
    if (!tool) return fail("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
    if (args === null || args === undefined) args = {};
    if (typeof args !== "object" || Array.isArray(args)) return fail("TOOL_INVALID_ARGUMENTS", "Tool arguments must be a JSON object.");
    let value = args as Record<string, unknown>;
    if (tool.validate) {
      const checked = tool.validate(value);
      if (!checked.ok) return fail("TOOL_INVALID_ARGUMENTS", `Invalid arguments for ${name}: ${checked.message}`);
      value = checked.value;
    }
    try {
      const result = await tool.run(value, { documentId: this.documentId, requestId: turn.requestId, signal: turn.abort.signal });
      // Reported even after an interruption: the application did run it.
      this.emit({ type: "toolCompleted", callId, tool: name, ok: !result.isError, ...(result.isError ? { errorCode: "TOOL_FAILED" } : {}) }, turn.requestId);
      return result;
    } catch (e) {
      this.deps.log.warn(`tool ${name} threw`, e);
      return fail(e instanceof AiCliError ? e.code : "TOOL_FAILED", `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private emit(body: AiEventBody, requestId?: string): void {
    const event = this.deps.publish({ ...this.deps.scope, ...(requestId ? { requestId } : {}), ...body } as Omit<AiEvent, "seq" | "at">);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        this.deps.log.error("session listener threw", e);
      }
    }
  }
}
