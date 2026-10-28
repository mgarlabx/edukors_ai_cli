import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { AiCli } from "../engine.js";
import { AiCliError, toAiCliError } from "../errors.js";
import { readLines } from "../platform/process.js";
import type { AiSession } from "../session.js";
import type { ToolDefinition, ToolResult } from "../tools.js";
import { VERSION } from "../version.js";
import { isAbsolute } from "node:path";
import { listSkills } from "../skills.js";

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
 *   host → app   { id: "h:<n>", method: "tool.authorize", params }
 *                the host asks the app whether a call to one of the user's MCP
 *                servers may go ahead; the app answers { allow, message? }
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
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    skillsDir: z.string().optional(),
    workspace: z
      .object({ dir: z.string(), readDirs: z.array(z.string()).optional(), protect: z.array(z.string()).optional(), web: z.boolean().optional(), shell: z.boolean().optional() })
      .optional(),
  }),
  "session.send": SessionRef.extend({ text: z.string(), requestId: z.string().optional(), context: z.string().optional() }),
  "session.interrupt": SessionRef,
  "session.answer": SessionRef.extend({ questionId: z.string(), answer: z.string() }),
  "session.updateOptions": SessionRef.extend({ options: Options }),
  "session.close": SessionRef,
  "diagnostics.report": z.object({}),
  /** The skills in a folder, for the settings screen. */
  "skills.list": z.object({ dir: z.string() }),
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
const AuthorizeReply = z.object({ allow: z.boolean(), message: z.string().optional() });

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
  /** Requests to the app waiting for its answer: tool calls and authorizations. */
  const toolCalls = new Map<string, { resolve: (result: unknown, error?: { message?: string }) => void; timer: NodeJS.Timeout }>();

  /** Asks the app something and waits; the timeout answers with `fallback`. */
  const askApp = <T>(method: string, params: Record<string, unknown>, parse: (result: unknown, error?: { message?: string }) => T, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const id = `h:${nextToolCall++}`;
      const timer = setTimeout(() => {
        toolCalls.delete(id);
        resolve(fallback);
      }, toolTimeoutMs);
      toolCalls.set(id, { resolve: (result, error) => resolve(parse(result, error)), timer });
      write({ id, method, params });
    });
  const inFlight = new Set<Promise<unknown>>();
  let nextToolCall = 1;

  ai.onEvent((event) => write({ event }));

  /** A tool whose work happens in the application, across the pipe. */
  const remoteTool = (spec: z.infer<typeof ToolSpecSchema>, sessionId: () => string): ToolDefinition => ({
    ...spec,
    run: (args, context) =>
      askApp(
        "tool.call",
        { sessionId: sessionId(), requestId: context.requestId, callId: context.callId, documentId: context.documentId, name: spec.name, args },
        (result, error): ToolResult => {
          const reply = ToolReply.safeParse(result);
          return error || !reply.success ? { content: error?.message ?? "The editor returned an invalid tool result.", isError: true } : reply.data;
        },
        { content: "The editor did not answer in time.", isError: true },
      ),
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
        const opened = await ai.openSession({
          accountId: p.accountId,
          documentId: p.documentId,
          instructions: p.instructions,
          tools,
          options: p.options,
          resumeId: p.resumeId,
          ...(p.mcpServers ? { mcpServers: p.mcpServers } : {}),
          ...(p.skillsDir ? { skillsDir: p.skillsDir } : {}),
          ...(p.workspace ? { workspace: p.workspace } : {}),
          authorize: ({ signal: _signal, ...request }) =>
            askApp(
              "tool.authorize",
              { sessionId, ...request },
              (result, error) => {
                const reply = AuthorizeReply.safeParse(result);
                return error || !reply.success ? { allow: false as const, message: error?.message ?? "The editor gave no valid answer." } : reply.data.allow ? { allow: true as const } : { allow: false as const, ...(reply.data.message ? { message: reply.data.message } : {}) };
              },
              { allow: false as const, message: "The editor did not answer in time." },
            ),
        });
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
      case "skills.list":
        if (!isAbsolute(p.dir)) throw new AiCliError("INVALID_ARGUMENT", "dir must be an absolute path");
        return listSkills(p.dir);
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
      pending.resolve(message.result, message.error ?? undefined);
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
        pending.resolve(undefined, { message: "The editor closed." });
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
