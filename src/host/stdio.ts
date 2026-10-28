import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { AiCli } from "../engine.js";
import { AiCliError, toAiCliError } from "../errors.js";
import { readLines } from "../platform/process.js";
import type { AiSession } from "../session.js";
import type { ToolDefinition, ToolResult } from "../tools.js";
import { VERSION } from "../version.js";

/**
 * The application-host protocol: the library behind a pipe, one JSON object
 * per line. The Tauri app runs it as a sidecar; the Electron app can run it
 * in a worker process. Both speak the same messages.
 *
 *   app → host   { id, method, params }          a request
 *   host → app   { id, result } | { id, error }  its answer
 *   host → app   { event }                        a normalized AiEvent
 *   host → app   { login: { requestId, accountId, url, acceptsCode } }
 *                a sign-in address for the user while accounts.connect runs;
 *                with acceptsCode, the app collects the pasted code and sends
 *                accounts.submitCode
 *   host → app   { id: "h:<n>", method: "tool.call", params }   the host asks the app to run a tool
 *   app → host   { id: "h:<n>", result } | { id: "h:<n>", error }
 *
 * The first line the host writes is { ready: { protocol, version } }.
 * Nothing else is written to the output; diagnostics go to stderr.
 */

export const HOST_PROTOCOL_VERSION = 1;

const ToolSpecSchema = z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) });
const Options = z.object({ model: z.string().optional(), effort: z.string().optional() });
const Account = z.object({ accountId: z.string() });
const SessionRef = z.object({ sessionId: z.string() });

const METHODS = {
  "providers.list": z.object({}),
  "providers.detect": z.object({ providerId: z.string().optional(), refresh: z.boolean().optional() }),
  "providers.capabilities": z.object({ providerId: z.string() }),
  "accounts.list": z.object({}),
  "accounts.create": z.object({ providerId: z.string(), label: z.string().optional() }),
  "accounts.rename": Account.extend({ label: z.string() }),
  "accounts.remove": Account.extend({ deleteData: z.boolean().optional() }),
  "accounts.connect": Account,
  "accounts.submitCode": Account.extend({ code: z.string() }),
  "accounts.status": Account,
  "accounts.logout": Account,
  "models.list": Account,
  "usage.read": Account,
  "session.open": z.object({
    accountId: z.string(),
    documentId: z.string(),
    instructions: z.string().optional(),
    tools: z.array(ToolSpecSchema).optional(),
    options: Options.optional(),
    resumeId: z.string().optional(),
  }),
  "session.send": SessionRef.extend({ text: z.string(), requestId: z.string().optional(), context: z.string().optional() }),
  "session.interrupt": SessionRef,
  "session.answer": SessionRef.extend({ questionId: z.string(), answer: z.string() }),
  "session.updateOptions": SessionRef.extend({ options: Options }),
  "session.close": SessionRef,
  "diagnostics.report": z.object({}),
  /** Aborts a pending request that supports it (accounts.connect). */
  cancel: z.object({ requestId: z.union([z.string(), z.number()]) }),
} as const;

type Method = keyof typeof METHODS;
type Id = string | number;

const Message = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

const ToolReply = z.object({ content: z.string(), isError: z.boolean().optional() });

export interface StdioHostOptions {
  ai: AiCli;
  input: Readable;
  output: Writable;
  /** How long the app has to answer a tool call. */
  toolTimeoutMs?: number;
}

export function runStdioHost({ ai, input, output, toolTimeoutMs = 120_000 }: StdioHostOptions): { closed: Promise<void> } {
  const log = ai.diagnostics.scoped("host");
  const write = (msg: unknown) => output.write(JSON.stringify(msg) + "\n");
  const sessions = new Map<string, AiSession>();
  const aborts = new Map<Id, AbortController>();
  const toolCalls = new Map<string, { resolve: (r: ToolResult) => void; timer: NodeJS.Timeout }>();
  const inFlight = new Set<Promise<unknown>>();
  let nextToolCall = 1;

  ai.onEvent((event) => write({ event }));

  /** A tool whose work happens in the application, across the pipe. */
  const remoteTool = (spec: z.infer<typeof ToolSpecSchema>, sessionId: () => string): ToolDefinition => ({
    ...spec,
    run: (args, context) =>
      new Promise<ToolResult>((resolve) => {
        const id = `h:${nextToolCall++}`;
        const timer = setTimeout(() => {
          toolCalls.delete(id);
          resolve({ content: "The editor did not answer in time.", isError: true });
        }, toolTimeoutMs);
        toolCalls.set(id, { resolve, timer });
        write({ id, method: "tool.call", params: { sessionId: sessionId(), requestId: context.requestId, documentId: context.documentId, name: spec.name, args } });
      }),
  });

  const session = (id: string) => {
    const found = sessions.get(id);
    if (!found) throw new AiCliError("SESSION_CLOSED", "no such session", { meta: { sessionId: id } });
    return found;
  };

  async function handle(id: Id, method: Method, raw: unknown): Promise<unknown> {
    const parsed = METHODS[method].safeParse(raw ?? {});
    if (!parsed.success) throw new AiCliError("INVALID_ARGUMENT", z.prettifyError(parsed.error), { meta: { method } });
    const p = parsed.data as Record<string, any>;
    switch (method) {
      case "providers.list":
        return ai.providers();
      case "providers.detect":
        return p.providerId ? [await ai.detect(p.providerId, { refresh: p.refresh })] : ai.detectAll({ refresh: p.refresh });
      case "providers.capabilities":
        return ai.capabilities(p.providerId);
      case "accounts.list":
        return ai.listAccounts();
      case "accounts.create":
        return ai.createAccount({ providerId: p.providerId, label: p.label });
      case "accounts.rename":
        return ai.renameAccount(p.accountId, p.label);
      case "accounts.remove":
        await ai.removeAccount(p.accountId, { deleteData: p.deleteData });
        return null;
      case "accounts.connect": {
        const controller = new AbortController();
        aborts.set(id, controller);
        try {
          return await ai.connectAccount(p.accountId, {
            signal: controller.signal,
            onLogin: (prompt) => write({ login: { requestId: id, accountId: p.accountId, ...prompt } }),
          });
        } finally {
          aborts.delete(id);
        }
      }
      case "accounts.submitCode":
        ai.submitLoginCode(p.accountId, p.code);
        return null;
      case "accounts.status":
        return ai.accountStatus(p.accountId);
      case "accounts.logout":
        await ai.logoutAccount(p.accountId);
        return null;
      case "models.list":
        return ai.listModels(p.accountId);
      case "usage.read":
        return ai.readUsage(p.accountId);
      case "session.open": {
        let sessionId = "";
        const tools = (p.tools ?? []).map((t: z.infer<typeof ToolSpecSchema>) => remoteTool(t, () => sessionId));
        const opened = await ai.openSession({ accountId: p.accountId, documentId: p.documentId, instructions: p.instructions, tools, options: p.options, resumeId: p.resumeId });
        sessionId = opened.id;
        sessions.set(opened.id, opened);
        opened.on((e) => e.type === "sessionClosed" && sessions.delete(opened.id));
        return { sessionId: opened.id, resumeId: opened.resumeId ?? null };
      }
      case "session.send":
        return session(p.sessionId).send(p.text, { requestId: p.requestId, context: p.context });
      case "session.interrupt":
        await session(p.sessionId).interrupt();
        return null;
      case "session.answer":
        session(p.sessionId).answer(p.questionId, p.answer);
        return null;
      case "session.updateOptions":
        await session(p.sessionId).updateOptions(p.options);
        return null;
      case "session.close":
        await session(p.sessionId).close();
        return null;
      case "diagnostics.report":
        return ai.diagnosticReport();
      case "cancel":
        aborts.get(p.requestId)?.abort();
        return null;
    }
  }

  readLines(input, (line) => {
    if (!line.trim()) return;
    let message: z.infer<typeof Message>;
    try {
      message = Message.parse(JSON.parse(line));
    } catch (e) {
      log.warn("ignored an invalid message", { line: line.slice(0, 200) });
      return;
    }
    const { id } = message;
    // An answer to a tool call.
    if (typeof id === "string" && id.startsWith("h:") && !message.method) {
      const pending = toolCalls.get(id);
      if (!pending) return;
      toolCalls.delete(id);
      clearTimeout(pending.timer);
      const reply = ToolReply.safeParse(message.result);
      pending.resolve(message.error || !reply.success ? { content: message.error?.message ?? "The editor returned an invalid tool result.", isError: true } : reply.data);
      return;
    }
    const method = message.method;
    if (!method || !(method in METHODS)) {
      write({ id, error: new AiCliError("INVALID_ARGUMENT", `unknown method: ${method}`).toJSON() });
      return;
    }
    const work = handle(id, method as Method, message.params).then(
      (result) => write({ id, result: result ?? null }),
      (e) => write({ id, error: toAiCliError(e).toJSON() }),
    );
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  });

  const closed = new Promise<void>((resolve) => {
    input.on("end", async () => {
      // The application stopped writing: tools can no longer be answered, and
      // running requests are stopped, but every request still gets its answer.
      for (const pending of toolCalls.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ content: "The editor closed.", isError: true });
      }
      for (const controller of aborts.values()) controller.abort();
      const settled = Promise.allSettled([...inFlight]);
      await ai.dispose();
      await settled;
      resolve();
    });
  });

  write({ ready: { protocol: HOST_PROTOCOL_VERSION, version: VERSION } });
  return { closed };
}
