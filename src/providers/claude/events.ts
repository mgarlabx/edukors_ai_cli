import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AiCliError } from "../../errors.js";
import { fromWindows, type ActivityPhase, type LimitWindow, type Usage } from "../../events.js";

/**
 * Claude Code's messages, as what a turn needs. This file has no SDK runtime
 * import, so it is tested on its own (test/claude.test.ts). Messages of a
 * subagent (`parent_tool_use_id`) are not the conversation's own and are
 * ignored, except for the result, which always belongs to the turn.
 */

export type ClaudeAction =
  | { kind: "sessionId"; id: string }
  | { kind: "text"; text: string }
  | { kind: "activity"; phase: ActivityPhase }
  | { kind: "usage"; usage: Omit<Usage, "observedAt"> }
  /** A failure reported mid-turn; the turn ends with it unless it recovers. */
  | { kind: "error"; error: AiCliError }
  | { kind: "end"; outcome: "completed" | "cancelled" }
  | { kind: "fail"; error: AiCliError };

/** Claude Code's error names on a message, as stable codes. */
export function claudeError(name: string, detail?: string): AiCliError {
  const meta = { providerCode: name, ...(detail ? { detail: detail.slice(0, 300) } : {}) };
  switch (name) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return new AiCliError("ACCOUNT_EXPIRED", "Claude needs to be signed in again", { meta });
    case "rate_limit":
      return new AiCliError("RATE_LIMITED", "Claude's usage limit was reached", { meta });
    case "overloaded":
    case "server_error":
      return new AiCliError("PROVIDER_ERROR", "Claude is temporarily unavailable", { meta, retryable: true });
    default:
      return new AiCliError("PROVIDER_ERROR", "Claude could not complete the request", { meta });
  }
}

const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

const when = (seconds: number) => new Date(seconds * (seconds < 1e12 ? 1000 : 1)).toISOString();

/** A share from 0 to 1, whichever scale the provider used. */
const share = (value: number) => (value > 1 ? value / 100 : value);

export function interpret(msg: SDKMessage): ClaudeAction[] {
  switch (msg.type) {
    case "system":
      return msg.subtype === "init" ? [{ kind: "sessionId", id: msg.session_id }] : [];

    case "stream_event": {
      if (msg.parent_tool_use_id) return [];
      const event = msg.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") return [{ kind: "text", text: event.delta.text }];
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "thinking" || block.type === "redacted_thinking") return [{ kind: "activity", phase: "thinking" }];
        if (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") {
          return [{ kind: "activity", phase: WEB_TOOLS.has(block.name) || block.type === "server_tool_use" ? "researching" : "applying" }];
        }
      }
      return [];
    }

    case "assistant":
      if (msg.parent_tool_use_id || !msg.error) return [];
      return [{ kind: "error", error: claudeError(msg.error) }];

    case "auth_status":
      return msg.error ? [{ kind: "error", error: claudeError("authentication_failed", msg.error) }] : [];

    case "rate_limit_event": {
      // `unifiedWindows` holds every window; the top-level fields describe only `rateLimitType`.
      const info = msg.rate_limit_info as typeof msg.rate_limit_info & { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> };
      const entries: [string, { utilization?: number; resetsAt?: number }][] = info.unifiedWindows
        ? Object.entries(info.unifiedWindows)
        : [[info.rateLimitType ?? "limit", { ...(info.utilization !== undefined ? { utilization: info.utilization } : {}), ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}) }]];
      const windows: LimitWindow[] = [];
      for (const [name, w] of entries) {
        if (typeof w?.utilization !== "number") continue;
        windows.push({ name, used: share(w.utilization), ...(typeof w.resetsAt === "number" ? { resetsAt: when(w.resetsAt) } : {}) });
      }
      return windows.length ? [{ kind: "usage", usage: fromWindows(windows) }] : [];
    }

    case "result": {
      const u = msg.usage;
      const actions: ClaudeAction[] = [
        {
          kind: "usage",
          usage: {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cachedInputTokens: u.cache_read_input_tokens,
            costUsd: msg.total_cost_usd,
          },
        },
      ];
      if (msg.subtype === "success" && !msg.is_error) actions.push({ kind: "end", outcome: "completed" });
      else if (msg.terminal_reason?.startsWith("aborted")) actions.push({ kind: "end", outcome: "cancelled" });
      else {
        const detail = "errors" in msg ? msg.errors.join("\n") : msg.result;
        actions.push({ kind: "fail", error: new AiCliError("PROVIDER_ERROR", "Claude could not complete the request", { meta: { providerCode: msg.subtype, detail: detail.slice(0, 300) } }) });
      }
      return actions;
    }

    default:
      return [];
  }
}
