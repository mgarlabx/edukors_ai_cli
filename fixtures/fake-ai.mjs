#!/usr/bin/env node
// A stand-in for a provider CLI, for deterministic tests. It behaves like a
// real one where it matters to the library: a separate process, its own
// sign-in state in a home directory (FAKE_AI_HOME), a version, a JSON-lines
// session protocol, persisted conversations, and failures on demand.
//
// Commands: --version | login --label <l> | status | logout | models | serve [--resume <id>]
//
// What a turn does depends on words in the request's last paragraph (an
// editor may put its own context before the person's words):
//   tool <name> [<json>]  calls an application tool and reports the result
//   mcp <server> <tool> [<json>]  calls a tool of one of the user's MCP servers
//   ask                   asks the user a question and reports the answer
//   slow                  streams for two seconds, stopping when interrupted
//   ignore-interrupt      streams for two seconds and ignores interruptions
//   late                  after an interruption, still sends a stale text
//   crash                 exits in the middle of the turn
//   garbage               prints a line that is not JSON first
//   rate-limit            fails with a rate-limit error
//   env                   reports which credential variables it inherited
//   anything else         echoes the request
//
// Environment toggles: FAKE_AI_VERSION, FAKE_AI_LOGIN=fail|hang,
// FAKE_AI_SERVE=silent (never becomes ready).
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const VERSION = process.env.FAKE_AI_VERSION ?? "1.4.0";
const HOME = process.env.FAKE_AI_HOME;
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (command === "--version") {
  console.log(`fake-ai ${VERSION}`);
  process.exit(0);
}
if (!HOME) {
  console.error("FAKE_AI_HOME is not set");
  process.exit(2);
}
const authFile = join(HOME, "auth.json");
const readAuth = () => (existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : null);

switch (command) {
  case "login": {
    if (process.env.FAKE_AI_LOGIN === "fail") {
      console.error("login rejected by the provider");
      process.exit(1);
    }
    if (process.env.FAKE_AI_LOGIN === "hang") await sleep(60_000);
    mkdirSync(HOME, { recursive: true });
    writeFileSync(authFile, JSON.stringify({ user: flag("--label") ?? "user", token: `fake-token-${randomUUID()}`, expired: false }));
    console.log("signed in");
    process.exit(0);
  }
  case "status": {
    const auth = readAuth();
    out(auth ? { signedIn: true, user: auth.user, expired: Boolean(auth.expired) } : { signedIn: false });
    process.exit(0);
  }
  case "logout":
    rmSync(authFile, { force: true });
    process.exit(0);
  case "models":
    out({
      models: [
        { id: "fake-fast", label: "Fake Fast", default: true },
        { id: "fake-deep", label: "Fake Deep", efforts: ["low", "medium", "high"] },
      ],
    });
    process.exit(0);
  case "serve":
    await serve();
    break;
  default:
    console.error(`unknown command: ${command}`);
    process.exit(2);
}

async function serve() {
  const auth = readAuth();
  if (!auth) {
    out({ type: "fatal", code: "auth", message: "not signed in" });
    process.exit(3);
  }
  if (auth.expired) {
    out({ type: "fatal", code: "expired", message: "the sign-in expired" });
    process.exit(3);
  }
  if (process.env.FAKE_AI_SERVE === "silent") {
    await sleep(60_000);
    return;
  }

  const sessionsDir = join(HOME, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const resume = flag("--resume");
  const sessionId = resume && existsSync(join(sessionsDir, `${resume}.json`)) ? resume : randomUUID();
  const file = join(sessionsDir, `${sessionId}.json`);
  const history = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { turns: [] };
  const save = () => writeFileSync(file, JSON.stringify(history));
  save();

  let options = { tools: [], instructions: "", model: undefined, effort: undefined };
  let current = null;
  const waiting = new Map();

  out({ type: "ready", sessionId, resumed: sessionId === resume, user: auth.user, turns: history.turns.length });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.type) {
      case "init":
        options = { ...options, ...msg };
        break;
      case "options":
        options = { ...options, model: msg.model, effort: msg.effort };
        break;
      case "turn":
        current = { turnId: msg.turnId, interrupted: false };
        runTurn(current, lastParagraph(msg.text)).catch((e) => out({ type: "error", turnId: msg.turnId, code: "internal", message: String(e?.message ?? e) }));
        break;
      case "interrupt":
        if (current) current.interrupted = true;
        for (const [id, resolve] of waiting) {
          waiting.delete(id);
          resolve(null);
        }
        break;
      case "tool_result":
      case "answer": {
        const id = msg.callId ?? msg.questionId;
        waiting.get(id)?.(msg);
        waiting.delete(id);
        break;
      }
      case "exit":
        process.exit(0);
    }
  });
  rl.on("close", () => process.exit(0));

  const wait = (id) => new Promise((resolve) => waiting.set(id, resolve));
  const lastParagraph = (text) => text.trim().split(/\n\s*\n/).pop() ?? "";

  async function runTurn(turn, text) {
    const send = (m) => out({ ...m, turnId: turn.turnId });
    const stopped = () => turn.interrupted && !/ignore-interrupt/.test(text);
    const cancelled = async () => {
      send({ type: "cancelled" });
      current = null;
      if (/late/.test(text)) {
        await sleep(30);
        send({ type: "text", delta: "LATE OUTPUT" });
        send({ type: "done" });
      }
    };

    send({ type: "activity", phase: "thinking" });
    if (/garbage/.test(text)) process.stdout.write("this is not json\n");
    if (/crash/.test(text)) {
      send({ type: "text", delta: "about to crash" });
      await sleep(20);
      process.exit(70);
    }
    if (/rate-limit/.test(text)) {
      send({ type: "error", code: "rate_limited", message: "too many requests" });
      current = null;
      return;
    }

    let reply;
    const tool = /\btool (\w+)(?: (\{.*\}))?/.exec(text);
    const mcp = /\bmcp ([\w-]+) (\w+)(?: (\{.*\}))?/.exec(text);
    if (mcp) {
      const callId = randomUUID();
      send({ type: "activity", phase: "applying" });
      send({ type: "mcp_call", callId, server: mcp[1], name: mcp[2], args: mcp[3] ? JSON.parse(mcp[3]) : {} });
      const result = await wait(callId);
      if (stopped() || !result) return cancelled();
      reply = `${mcp[1]}.${mcp[2]} said: ${result.content}${result.isError ? " (error)" : ""}`;
    } else if (tool) {
      const callId = randomUUID();
      send({ type: "activity", phase: "applying" });
      send({ type: "tool_call", callId, name: tool[1], args: tool[2] ? JSON.parse(tool[2]) : {} });
      const result = await wait(callId);
      if (stopped() || !result) return cancelled();
      reply = `Tool ${tool[1]} said: ${result.content}${result.isError ? " (error)" : ""}`;
    } else if (/\bask\b/.test(text)) {
      const questionId = randomUUID();
      send({ type: "question", questionId, prompt: "Which color?", options: ["red", "blue"] });
      const answer = await wait(questionId);
      if (stopped() || !answer) return cancelled();
      reply = `You chose ${answer.answer}`;
    } else if (/slow|ignore-interrupt|late/.test(text)) {
      for (let i = 0; i < 40; i++) {
        if (stopped()) return cancelled();
        send({ type: "text", delta: "." });
        await sleep(50);
      }
      reply = "done slowly";
    } else if (/\benv\b/.test(text)) {
      const seen = (name) => `${name}=${process.env[name] ? "present" : "absent"}`;
      reply = [seen("ANTHROPIC_API_KEY"), seen("OPENAI_API_KEY"), seen("CLAUDE_CONFIG_DIR"), `user=${auth.user}`].join(" ");
    } else {
      reply = `Echo: ${text} [history ${history.turns.length}, model ${options.model ?? "default"}, tools ${options.tools.length}]`;
    }

    const third = Math.ceil(reply.length / 3);
    for (let i = 0; i < reply.length; i += third) send({ type: "text", delta: reply.slice(i, i + third) });
    history.turns.push(text);
    save();
    send({ type: "usage", inputTokens: text.length, outputTokens: reply.length });
    send({ type: "done" });
    current = null;
  }
}
