import { AiCliError } from "../../errors.js";
import type { ScopedLog } from "../../diagnostics.js";
import { readLines, type ManagedProcess } from "../../platform/process.js";

/**
 * JSON-RPC over a child process's pipes, one message per line, as Codex's
 * app server speaks it: without the `"jsonrpc"` field. Three kinds of
 * traffic: requests the client waits on, notifications from the server, and
 * requests from the server (an approval, a question) answered by the same id.
 */

export interface RpcHandlers {
  onNotification?: (method: string, params: any) => void;
  onRequest?: (method: string, params: any) => Promise<unknown>;
}

export interface Rpc {
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
}

export function attachRpc(proc: ManagedProcess, handlers: RpcHandlers, log: ScopedLog): Rpc {
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  let nextId = 1;

  const fail = (reason: string) => {
    for (const [id, waiting] of pending) {
      pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new AiCliError("PROVIDER_CRASHED", reason, { meta: { method: waiting.method } }));
    }
  };
  void proc.exited.then(() => fail("the Codex app server stopped"));

  readLines(
    proc.child.stdout,
    (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn("ignored a line that is not JSON-RPC", { line: line.slice(0, 200) });
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const hasId = msg.id !== undefined && msg.id !== null;
      if (hasId && typeof msg.method === "string") {
        const answer = handlers.onRequest ? handlers.onRequest(msg.method, msg.params ?? {}) : Promise.reject(new Error(`unhandled request: ${msg.method}`));
        answer.then(
          (result) => proc.writeLine({ id: msg.id, result: result ?? null }),
          (e) => {
            log.debug(`request ${msg.method} refused`, { message: e instanceof Error ? e.message : String(e) });
            proc.writeLine({ id: msg.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
          },
        );
        return;
      }
      if (hasId) {
        const waiting = pending.get(msg.id);
        if (!waiting) return;
        pending.delete(msg.id);
        clearTimeout(waiting.timer);
        if (msg.error) waiting.reject(new AiCliError("PROVIDER_ERROR", String(msg.error.message ?? "Codex refused the request"), { meta: { method: waiting.method, rpcCode: msg.error.code } }));
        else waiting.resolve(msg.result ?? null);
        return;
      }
      if (typeof msg.method === "string") handlers.onNotification?.(msg.method, msg.params ?? {});
    },
    { onOverflow: () => log.warn("discarded an oversized line from Codex") },
  );

  return {
    request(method, params = {}, timeoutMs = 120_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AiCliError("TIMEOUT", `Codex did not answer ${method} in time`, { meta: { method } }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        if (!proc.writeLine({ id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new AiCliError("PROVIDER_CRASHED", "the Codex app server is not running", { meta: { method } }));
        }
      });
    },
    notify(method, params = {}) {
      proc.writeLine({ method, params });
    },
  };
}
