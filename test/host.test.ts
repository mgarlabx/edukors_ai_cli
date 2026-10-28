import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { createAiCli } from "../src/index.js";
import { runStdioHost } from "../src/host/stdio.js";
import { createFakeProvider } from "../src/testing/index.js";
import { tempDir, until } from "./helpers.js";

/** Plays the application's side of the pipe. */
async function harness() {
  const ai = createAiCli({ appId: "graph", dataDir: await tempDir(), providers: [createFakeProvider()], interruptGraceMs: 400 });
  const input = new PassThrough();
  const output = new PassThrough();
  const host = runStdioHost({ ai, input, output });
  const received: any[] = [];
  const waiting = new Map<number, (msg: any) => void>();
  let toolHandler: (params: any) => unknown = () => ({ content: "" });
  createInterface({ input: output }).on("line", (line) => {
    const msg = JSON.parse(line);
    received.push(msg);
    if (msg.method === "tool.call") {
      Promise.resolve(toolHandler(msg.params)).then((result) => input.write(JSON.stringify({ id: msg.id, result }) + "\n"));
    } else if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      input.write(JSON.stringify({ id, method, params }) + "\n");
    });
  return {
    call,
    received,
    events: () => received.filter((m) => m.event).map((m) => m.event),
    onTool: (fn: (params: any) => unknown) => (toolHandler = fn),
    raw: (line: string) => input.write(line + "\n"),
    close: async () => {
      input.end();
      await host.closed;
    },
  };
}

describe("stdio host", () => {
  it("runs the whole flow over the pipe, tools included", async () => {
    const h = await harness();
    try {
      await until(() => h.received.length > 0);
      expect(h.received[0]).toEqual({ ready: { protocol: 1, version: expect.any(String) } });

      expect((await h.call("providers.detect")).result).toEqual([expect.objectContaining({ providerId: "fake", status: "ready" })]);
      const account = (await h.call("accounts.create", { providerId: "fake", label: "Personal" })).result;
      expect((await h.call("accounts.connect", { accountId: account.id })).result).toMatchObject({ state: "connected" });

      const toolCalls: any[] = [];
      h.onTool((params) => {
        toolCalls.push(params);
        return { content: `title is now ${params.args.title}` };
      });
      const opened = (
        await h.call("session.open", {
          accountId: account.id,
          documentId: "course-1",
          tools: [{ name: "set_title", description: "Sets the course title.", inputSchema: { type: "object", properties: { title: { type: "string" } } } }],
        })
      ).result;
      expect(opened.sessionId).toEqual(expect.any(String));

      const sent = await h.call("session.send", { sessionId: opened.sessionId, text: 'tool set_title {"title":"Física"}', requestId: "r1" });
      expect(sent.result).toEqual({ requestId: "r1", status: "completed" });
      expect(toolCalls).toEqual([{ sessionId: opened.sessionId, requestId: "r1", documentId: "course-1", name: "set_title", args: { title: "Física" } }]);
      const text = h.events().filter((e) => e.type === "textDelta" && e.requestId === "r1").map((e) => e.text).join("");
      expect(text).toBe("Tool set_title said: title is now Física");

      expect((await h.call("session.close", { sessionId: opened.sessionId })).result).toBeNull();
      expect(h.events().at(-1)).toMatchObject({ type: "sessionClosed" });
    } finally {
      await h.close();
    }
  });

  it("answers bad requests with stable error codes", async () => {
    const h = await harness();
    try {
      expect((await h.call("no.such.method")).error).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect((await h.call("accounts.create", { label: 3 })).error).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect((await h.call("accounts.status", { accountId: "missing-account" })).error).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
      expect((await h.call("session.send", { sessionId: "nope", text: "x" })).error).toMatchObject({ code: "SESSION_CLOSED" });
      h.raw("not json at all");
      expect((await h.call("providers.list")).result).toEqual([expect.objectContaining({ id: "fake" })]);
    } finally {
      await h.close();
    }
  });

  it("interrupts over the pipe", async () => {
    const h = await harness();
    try {
      const account = (await h.call("accounts.create", { providerId: "fake" })).result;
      await h.call("accounts.connect", { accountId: account.id });
      const { sessionId } = (await h.call("session.open", { accountId: account.id, documentId: "d" })).result;
      const pending = h.call("session.send", { sessionId, text: "slow", requestId: "s" });
      await until(() => h.events().some((e) => e.type === "textDelta" && e.requestId === "s"));
      await h.call("session.interrupt", { sessionId });
      expect((await pending).result).toEqual({ requestId: "s", status: "cancelled" });
    } finally {
      await h.close();
    }
  });
});
