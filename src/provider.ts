import type { ActivityPhase, Usage } from "./events.js";
import type { ScopedLog } from "./diagnostics.js";
import type { ToolResult, ToolSpec } from "./tools.js";

/**
 * The contract each provider adapter implements. Adapters translate one
 * provider's CLI and protocol into this; the library handles accounts,
 * session identity, late events, tool routing and errors around it.
 *
 * Optional operations are capabilities, not simulations: an adapter that
 * cannot report usage says so, and the library reports usage as unavailable.
 */

export type DetectionStatus = "ready" | "missing" | "incompatible" | "error";

export interface Detection {
  providerId: string;
  status: DetectionStatus;
  executable?: string;
  version?: string;
  /** The minimum version this adapter supports, when the installed one is too old. */
  requiredVersion?: string;
  detail?: string;
}

export interface Capabilities {
  /** How the user signs in. `external` means the provider's own tooling must be used. */
  login: "browser" | "terminal" | "external";
  /** Account state can be read without sending a model request. */
  accountStatus: boolean;
  /** Separate accounts of this provider are verified to be isolated. */
  multiAccount: boolean;
  logout: boolean;
  /** Conversations can be resumed after the provider process ends. */
  persistentSessions: boolean;
  models: boolean;
  efforts: boolean;
  usage: boolean;
  tools: boolean;
  questions: boolean;
  /** Model or effort can change in an open session. */
  liveOptions: boolean;
}

export type AccountState = "connected" | "disconnected" | "expired" | "unknown";

export interface AccountStatus {
  state: AccountState;
  /** A display identity (e-mail, organization) only when the provider exposes one. */
  identity?: string;
  detail?: string;
}

export interface ModelInfo {
  id: string;
  label?: string;
  efforts?: string[];
  default?: boolean;
}

export interface SessionOptions {
  model?: string;
  effort?: string;
}

/** An address the user can open to sign in, offered while a sign-in runs. */
export interface LoginPrompt {
  url: string;
  /** The page ends with a code the user pastes back (see `AiCli.submitLoginCode`). */
  acceptsCode: boolean;
}

/** How a sign-in reaches the user while it runs. Present only during `connectAccount`. */
export interface LoginChannel {
  prompt(prompt: LoginPrompt): void;
  /** Resolves with the code the user pasted; rejects if the sign-in is cancelled. */
  code(): Promise<string>;
}

/** What an adapter receives for anything account-related. */
export interface AccountContext {
  accountId: string;
  label: string;
  /** An application-managed directory reserved for this account's provider configuration and credentials. */
  homeDir: string;
  detection: Detection;
  log: ScopedLog;
  signal?: AbortSignal;
  login?: LoginChannel;
}

export interface SessionContext extends AccountContext {
  appId: string;
  documentId: string;
  /** Scratch space for this application, document and account; never shared between documents. */
  workDir: string;
  instructions: string;
  tools: ToolSpec[];
  options: SessionOptions;
  /** The provider's own session identifier to resume, when the capability allows it. */
  resumeId?: string;
}

export interface SessionHooks {
  /** The provider process ended outside of a request. */
  exited(error: Error): void;
}

export interface TurnInput {
  requestId: string;
  text: string;
  /** Latest document context the application chose to include with this request. */
  context?: string;
}

/**
 * Bound to a single request. After the request is interrupted or replaced,
 * every call becomes a no-op (or is refused), so late output from a provider
 * cannot reach the application.
 */
export interface TurnSink {
  readonly signal: AbortSignal;
  text(delta: string): void;
  activity(phase: ActivityPhase, detail?: string): void;
  usage(usage: Omit<Usage, "observedAt"> & { observedAt?: string }): void;
  callTool(name: string, args: unknown): Promise<ToolResult>;
  ask(question: { prompt: string; options?: string[] }): Promise<string>;
}

export type TurnOutcome = "completed" | "cancelled";

export interface ProviderSession {
  /** The provider's own conversation id, used to resume. */
  readonly resumeId: string | undefined;
  /** Resolves when the turn ends; rejects with an AiCliError on failure. */
  send(input: TurnInput, sink: TurnSink): Promise<TurnOutcome>;
  /** Asks the provider to stop; the pending `send` should settle soon after. */
  interrupt(): Promise<void>;
  updateOptions?(options: SessionOptions): Promise<void>;
  /** Releases everything, including the process tree. Must settle any pending `send`. */
  close(): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Where the user installs the CLI from, for guided setup. */
  readonly installUrl?: string;
  detect(log: ScopedLog): Promise<Detection>;
  capabilities(detection: Detection): Capabilities;
  connectAccount(context: AccountContext): Promise<AccountStatus>;
  accountStatus(context: AccountContext): Promise<AccountStatus>;
  logout?(context: AccountContext): Promise<void>;
  listModels?(context: AccountContext): Promise<ModelInfo[]>;
  readUsage?(context: AccountContext): Promise<Usage | null>;
  openSession(context: SessionContext, hooks: SessionHooks): Promise<ProviderSession>;
}
