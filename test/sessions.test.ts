import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type AiEvent } from "../src/index.js";
import { connectedAccount, setup, tempDir, textOf, types, until } from "./helpers.js";

describe("sessions", () => {
  it("sends a request and streams normalized events with full scope", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "doc-1" });

    const result = await session.send("hello", { requestId: "r1" });

    expect(result).toEqual({ requestId: "r1", status: "completed" });
    expect(textOf(events, "r1")).toBe("Echo: hello [history 0, model default, tools 0]");
    expect(types(events, "r1")).toEqual(["activity", "activity", "textDelta", "textDelta", "textDelta", "usageUpdated", "turnCompleted"]);
    const opened = events.find((e) => e.type === "sessionOpened")!;
    expect(opened).toMatchObject({ appId: "test", documentId: "doc-1", accountId: account.id, providerId: "fake", sessionId: session.id, resumed: false });
    for (const e of events.filter((e) => e.requestId)) expect(e).toMatchObject({ appId: "test", documentId: "doc-1", accountId: account.id, sessionId: session.id });
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(session.state).toBe("idle");
  });

  it("works with a relative data directory", async () => {
    const { ai, events } = await setup({ ai: { dataDir: relative(process.cwd(), await tempDir()) } });
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    expect((await session.send("hi", { requestId: "r" })).status).toBe("completed");
    expect(textOf(events, "r")).toContain("Echo: hi");
  });

  it("refuses a second request while one is running", async () => {
    const { ai } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "doc" });
    const first = session.send("slow");
    await expect(session.send("again")).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await session.interrupt();
    expect((await first).status).toBe("cancelled");
  });

  it("routes tool calls to the application, validating arguments", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const applied: string[] = [];
    const rename = defineTool({
      name: "rename_slide",
      description: "Renames a slide.",
      input: z.object({ slide: z.number().int(), title: z.string().min(1) }),
      run: ({ slide, title }) => {
        applied.push(`${slide}:${title}`);
        return { content: "renamed" };
      },
    });
    const broken = defineTool({ name: "broken", description: "Always fails.", input: z.object({}), run: () => { throw new Error("disk full"); } });
    const session = await ai.openSession({ accountId: account.id, documentId: "deck", tools: [rename, broken] });

    expect((await session.send('tool rename_slide {"slide":2,"title":"Intro"}', { requestId: "ok" })).status).toBe("completed");
    expect(applied).toEqual(["2:Intro"]);
    expect(textOf(events, "ok")).toBe("Tool rename_slide said: renamed");
    expect(events.find((e) => e.requestId === "ok" && e.type === "toolCompleted")).toMatchObject({ tool: "rename_slide", ok: true });

    await session.send('tool rename_slide {"slide":"two"}', { requestId: "bad" });
    expect(applied).toHaveLength(1);
    expect(textOf(events, "bad")).toContain("Invalid arguments for rename_slide");
    expect(events.find((e) => e.requestId === "bad" && e.type === "toolCompleted")).toMatchObject({ ok: false, errorCode: "TOOL_INVALID_ARGUMENTS" });

    await session.send("tool delete_everything", { requestId: "unknown" });
    expect(events.find((e) => e.requestId === "unknown" && e.type === "toolCompleted")).toMatchObject({ ok: false, errorCode: "TOOL_NOT_FOUND" });

    await session.send("tool broken", { requestId: "throws" });
    expect(textOf(events, "throws")).toContain("disk full");
    expect(events.find((e) => e.requestId === "throws" && e.type === "toolCompleted")).toMatchObject({ ok: false, errorCode: "TOOL_FAILED" });
    expect(session.state).toBe("idle");
  });

  it("passes the provider the tool list and instructions", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const tool = defineTool({ name: "noop", description: "Does nothing.", input: z.object({}), run: () => ({ content: "" }) });
    const session = await ai.openSession({ accountId: account.id, documentId: "d", tools: [tool], options: { model: "fake-deep" } });
    await session.send("hi", { requestId: "r" });
    expect(textOf(events, "r")).toBe("Echo: hi [history 0, model fake-deep, tools 1]");
  });

  it("asks the user a question and continues with the answer", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    session.on((e) => {
      if (e.type === "question") session.answer(e.questionId, e.options![1]!);
    });
    await session.send("ask", { requestId: "q" });
    expect(events.find((e) => e.type === "question")).toMatchObject({ prompt: "Which color?", options: ["red", "blue"] });
    expect(textOf(events, "q")).toBe("You chose blue");
    expect(() => session.answer("nope", "x")).toThrow(expect.objectContaining({ code: "QUESTION_NOT_FOUND" }));
  });

  it("interrupts, settles, and drops output that arrives after the interruption", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    const pending = session.send("late", { requestId: "late" });
    await until(() => textOf(events, "late").length >= 2);

    await session.interrupt();

    expect(await pending).toEqual({ requestId: "late", status: "cancelled" });
    const countAtCancel = events.length;
    expect(events.at(-1)).toMatchObject({ type: "cancelled", requestId: "late" });
    // The fake CLI sends "LATE OUTPUT" 30ms after cancelling.
    await until(() => session.lateEventsDropped > 0);
    expect(events.length).toBe(countAtCancel);
    expect(textOf(events)).not.toContain("LATE");
    expect(session.state).toBe("idle");

    // The session is usable afterwards.
    expect((await session.send("again", { requestId: "next" })).status).toBe("completed");
  });

  it("shuts down a provider that ignores an interruption and resumes on the next request", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    await session.send("first", { requestId: "a" });
    const resumeId = session.resumeId;
    const pending = session.send("ignore-interrupt", { requestId: "stubborn" });
    await until(() => textOf(events, "stubborn").length >= 1);

    const started = Date.now();
    await session.interrupt();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await pending).status).toBe("cancelled");

    const next = await session.send("second", { requestId: "b" });
    expect(next.status).toBe("completed");
    expect(session.resumeId).toBe(resumeId);
    expect(textOf(events, "b")).toContain("[history 1,");
    expect(events.filter((e) => e.type === "sessionOpened").map((e) => (e as { resumed: boolean }).resumed)).toEqual([false, true]);
  });

  it("does not run a tool requested after the request was cancelled", async () => {
    const { ai } = await setup();
    const account = await connectedAccount(ai);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = defineTool({
      name: "slow_edit",
      description: "Waits.",
      input: z.object({}),
      run: async (_args, ctx) => {
        runs++;
        await gate;
        return { content: ctx.signal.aborted ? "aborted" : "done" };
      },
    });
    const session = await ai.openSession({ accountId: account.id, documentId: "d", tools: [slow] });
    const pending = session.send("tool slow_edit");
    await until(() => runs === 1);
    const interrupted = session.interrupt();
    release();
    await interrupted;
    expect((await pending).status).toBe("cancelled");
    expect(runs).toBe(1);
  });

  it("reports a crash, then recovers by resuming the conversation", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    await session.send("before", { requestId: "a" });

    const crashed = await session.send("crash", { requestId: "boom" });
    expect(crashed).toMatchObject({ status: "failed", error: { code: "PROVIDER_CRASHED", retryable: true } });
    expect(events.find((e) => e.type === "error" && e.requestId === "boom")).toBeTruthy();
    expect(session.state).toBe("failed");

    const after = await session.send("after", { requestId: "b" });
    expect(after.status).toBe("completed");
    expect(textOf(events, "b")).toContain("[history 1,");
    expect(session.state).toBe("idle");
  });

  it("maps provider errors to stable codes and ignores malformed output", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    expect(await session.send("rate-limit")).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED" } });
    expect(session.state).toBe("idle");

    expect((await session.send("garbage", { requestId: "g" })).status).toBe("completed");
    expect(textOf(events, "g")).toContain("Echo: garbage");
    expect(ai.diagnostics.snapshot().some((e) => e.message.includes("not JSON"))).toBe(true);
  });

  it("keeps sessions of different documents apart and resumes by saved id", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const a = await ai.openSession({ accountId: account.id, documentId: "doc-a" });
    const b = await ai.openSession({ accountId: account.id, documentId: "doc-b" });
    await a.send("one", { requestId: "a1" });
    await a.send("two", { requestId: "a2" });
    await b.send("one", { requestId: "b1" });
    expect(textOf(events, "a2")).toContain("[history 1,");
    expect(textOf(events, "b1")).toContain("[history 0,");
    expect(a.resumeId).not.toBe(b.resumeId);

    const saved = a.resumeId!;
    await a.close();
    expect(events.at(-1)).toMatchObject({ type: "sessionClosed", reason: "closed", sessionId: a.id });
    await expect(a.send("x")).rejects.toMatchObject({ code: "SESSION_CLOSED" });

    const reopened = await ai.openSession({ accountId: account.id, documentId: "doc-a", resumeId: saved });
    expect(reopened.id).not.toBe(a.id);
    await reopened.send("three", { requestId: "a3" });
    expect(textOf(events, "a3")).toContain("[history 2,");
  });

  it("changes options in an open session", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    await session.updateOptions({ model: "fake-deep", effort: "high" });
    await session.send("hi", { requestId: "r" });
    expect(textOf(events, "r")).toContain("model fake-deep");
  });

  it("closes this application's sessions when their account is removed", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    const session = await ai.openSession({ accountId: account.id, documentId: "d" });
    const pending = session.send("slow");
    await ai.removeAccount(account.id);
    expect((await pending).status).toBe("cancelled");
    expect(session.state).toBe("closed");
    expect(events.find((e) => e.type === "sessionClosed")).toMatchObject({ reason: "accountRemoved" });
    expect(ai.sessions()).toHaveLength(0);
  });

  it("does not let the parent environment's credentials reach the provider", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak-0000000000";
    process.env.CLAUDE_CONFIG_DIR = "/somewhere/else";
    try {
      const { ai, events } = await setup();
      const account = await connectedAccount(ai, "Work");
      const session = await ai.openSession({ accountId: account.id, documentId: "d" });
      await session.send("env", { requestId: "e" });
      expect(textOf(events, "e")).toBe("ANTHROPIC_API_KEY=absent OPENAI_API_KEY=absent CLAUDE_CONFIG_DIR=absent user=Work");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("disposes every session and its process", async () => {
    const { ai, events } = await setup();
    const account = await connectedAccount(ai);
    await ai.openSession({ accountId: account.id, documentId: "a" });
    const busy = await ai.openSession({ accountId: account.id, documentId: "b" });
    const pending = busy.send("slow");
    await ai.dispose();
    expect((await pending).status).toBe("cancelled");
    expect(events.filter((e: AiEvent) => e.type === "sessionClosed")).toHaveLength(2);
    await expect(ai.openSession({ accountId: account.id, documentId: "c" })).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });
});
