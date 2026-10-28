import type { SerializedError } from "./errors.js";

/**
 * Normalized events. Every provider's protocol is translated into these, so
 * applications never read provider-specific messages.
 */

/** Progress phases an application can show without exposing protocol details. */
export type ActivityPhase = "preparing" | "thinking" | "reading" | "researching" | "applying";

/**
 * Usage as the provider reports it. A missing field is unknown, never zero.
 * `observedAt` is when the provider reported it, for freshness display.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  /** Account-level limit: the most used window, as a fraction from 0 to 1, when the provider exposes it. */
  limitUsed?: number;
  limitResetsAt?: string;
  /** Every limit window the provider reported (e.g. `five_hour`, `seven_day`). */
  windows?: LimitWindow[];
  observedAt: string;
}

export interface LimitWindow {
  /** `five_hour`, `seven_day`, or the provider's own name for another window. */
  name: string;
  used: number;
  resetsAt?: string;
}

/** The account-level fields of a usage report, from its windows: the most used one leads. */
export function fromWindows(windows: LimitWindow[]): Pick<Usage, "limitUsed" | "limitResetsAt" | "windows"> {
  if (!windows.length) return {};
  const top = windows.reduce((a, b) => (b.used > a.used ? b : a));
  return { limitUsed: top.used, ...(top.resetsAt ? { limitResetsAt: top.resetsAt } : {}), windows };
}

/** Identifies what an event belongs to. `requestId` is absent for session-level events. */
export interface EventScope {
  appId: string;
  documentId: string;
  accountId: string;
  providerId: string;
  sessionId: string;
  requestId?: string;
}

export type SessionCloseReason = "closed" | "accountRemoved" | "disposed";

export type AiEventBody =
  | { type: "sessionOpened"; resumed: boolean }
  | { type: "textDelta"; text: string }
  | { type: "activity"; phase: ActivityPhase; detail?: string }
  | { type: "question"; questionId: string; prompt: string; options?: string[] }
  | { type: "toolStarted"; callId: string; tool: string }
  | { type: "toolCompleted"; callId: string; tool: string; ok: boolean; errorCode?: string }
  | { type: "usageUpdated"; usage: Usage }
  /** A user-configured MCP server's connection, reported when the session opens. */
  | { type: "mcpServerStatus"; server: string; status: "connected" | "failed"; tools?: number; error?: string }
  | { type: "turnCompleted" }
  | { type: "cancelled" }
  | { type: "error"; error: SerializedError }
  | { type: "sessionClosed"; reason: SessionCloseReason };

export type AiEventType = AiEventBody["type"];

/** `seq` increases monotonically per library instance; `at` is an ISO timestamp. */
export type AiEvent = EventScope & AiEventBody & { seq: number; at: string };

export type AiEventListener = (event: AiEvent) => void;
