#!/usr/bin/env node
// A stand-in for OpenAI's Codex CLI, for the tests. `codex app-server` speaks
// JSON-RPC over stdio without the "jsonrpc" field, keeps its sign-in and
// threads in CODEX_HOME, and reaches the application's tools through the MCP
// server given with `-c mcp_servers.<name>.url=...`, as the real one does.
//
// A turn depends on words in the request:
//   tool <name> [<json>]  calls an application tool over MCP
//   mcp <server> <tool> [<json>]  calls a tool of one of the user's servers, through the bridge
//   skill <name> [<file>] reads a skill through read_skill
//   developer             reports the developer instructions it was given
//   ask                   asks the user as Codex 0.164 does: an async message
//                         with questions, then sleeps until turn/steer answers
//   ask-blocking          asks the user through item/tool/requestUserInput
//   comando               asks to run a command and reports the decision
//   sandbox               reports how the session was set up (cwd, sandbox, approvals, web)
//   run <shell command>   asks to run it; if allowed, runs it with /bin/sh in the
//                         turn's folder, as Codex does in an external sandbox
//   slow                  streams until interrupted
//   late                  after an interruption, still sends stale text
//   crash                 exits in the middle of the turn
//   limit                 fails with usageLimitExceeded
//   env                   reports what it inherited
//   anything else         echoes the request
//
// Toggles: FAKE_CODEX_VERSION, FAKE_CODEX_LOGIN=fail.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.164.0"}`);
  process.exit(0);
}
const HOME = process.env.CODEX_HOME;
if (!HOME) {
  console.error("CODEX_HOME is not set");
  process.exit(2);
}
mkdirSync(HOME, { recursive: true });
const authFile = join(HOME, "auth.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args[0] === "login" && args[1] === "status") {
  if (existsSync(authFile)) {
    console.log("Logged in using ChatGPT");
    process.exit(0);
  }
  console.log("Not logged in");
  process.exit(1);
}
if (args[0] === "login") {
  if (process.env.FAKE_CODEX_LOGIN === "fail") {
    console.error("login cancelled");
    process.exit(1);
  }
  console.log("Starting local login server on http://localhost:1455.");
  console.log("If your browser did not open, navigate to this URL to authenticate:\n");
  console.log("https://auth.openai.com/oauth/authorize?response_type=code&client_id=fake-client&state=fake-state\n");
  writeFileSync(authFile, JSON.stringify({ tokens: { access_token: `fake-codex-token-${randomUUID()}` }, email: basename(HOME) }));
  console.log("Successfully logged in");
  process.exit(0);
}
if (args[0] === "logout") {
  rmSync(authFile, { force: true });
  process.exit(0);
}
if (args[0] !== "app-server") {
  console.error(`unknown command: ${args.join(" ")}`);
  process.exit(2);
}

// The MCP client loads only when a tool is called: inside the macOS sandbox of a
// workspace session, the fixture's own node_modules are out of reach.
const mcpClient = async () => ({
  Client: (await import("@modelcontextprotocol/sdk/client/index.js")).Client,
  StreamableHTTPClientTransport: (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport,
});

// -c key=value overrides, values in TOML (strings are JSON-compatible here).
const config = {};
for (let i = 0; i < args.length; i++)
  if (args[i] === "-c") {
    const [key, ...rest] = args[++i].split("=");
    config[key] = JSON.parse(rest.join("="));
  }
const mcpUrl = config["mcp_servers.edukors.url"];

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => out({ method, params });
let nextId = 1000;
const waiting = new Map();
const askClient = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    out({ id, method, params });
  });

const clients = new Map();
async function callTool(name, toolArgs, server = "edukors") {
  if (!clients.has(server)) {
    const url = config[`mcp_servers.${server}.url`];
    const token = process.env[config[`mcp_servers.${server}.bearer_token_env_var`] ?? ""];
    if (!url) return { text: `no MCP server ${server}`, isError: true };
    const { Client, StreamableHTTPClientTransport } = await mcpClient();
    const client = new Client({ name: "fake-codex", version: "0.164.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.set(server, client);
  }
  const result = await clients.get(server).callTool({ name, arguments: toolArgs });
  return { text: (result.content ?? []).map((c) => c.text ?? "").join("\n"), isError: Boolean(result.isError) };
}

let extraRoots = [];
const switchesFile = join(HOME, "skill-switches.json");
const readSwitches = () => (existsSync(switchesFile) ? JSON.parse(readFileSync(switchesFile, "utf8")) : {});

const threadsDir = join(HOME, "threads");
mkdirSync(threadsDir, { recursive: true });
let thread = null;
const saveThread = () => writeFileSync(join(threadsDir, `${thread.id}.json`), JSON.stringify(thread));
let current = null;
let turnCount = 0;

function reply(id, result) {
  out({ id, result });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, { userAgent: "fake-codex/0.164.0" });
    case "account/read":
      return reply(id, existsSync(authFile) ? { account: { type: "chatgpt", email: basename(HOME), planType: "plus" }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true });
    case "skills/extraRoots/set":
      extraRoots = params.extraRoots ?? [];
      return reply(id, {});
    case "skills/list": {
      // A bundled skill, and those found in the extra roots; switches persist in the account's config.
      const found = [{ name: "imagegen", path: "/bundled/imagegen/SKILL.md" }];
      for (const root of extraRoots)
        for (const entry of existsSync(root) ? readdirSync(root) : []) if (existsSync(join(root, entry, "SKILL.md"))) found.push({ name: entry, path: join(root, entry, "SKILL.md") });
      const switches = readSwitches();
      return reply(id, { data: [{ cwd: params.cwds?.[0], skills: found.map((sk) => ({ ...sk, enabled: switches[sk.path] ?? true })) }] });
    }
    case "skills/config/write":
      writeFileSync(switchesFile, JSON.stringify({ ...readSwitches(), [params.path]: params.enabled }));
      return reply(id, {});
    case "model/list":
      return reply(id, { data: [{ id: "gpt-fake", displayName: "GPT Fake", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }, { id: "hidden", hidden: true }] });
    case "account/rateLimits/read":
      return reply(id, { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } } });
    case "thread/start":
      thread = { id: randomUUID(), turns: [], instructions: params.baseInstructions ?? null, developer: params.developerInstructions ?? null, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy, cwd: params.cwd };
      saveThread();
      return reply(id, { thread: { id: thread.id }, model: params.model ?? "gpt-fake" });
    case "thread/resume": {
      const file = join(threadsDir, `${params.threadId}.json`);
      if (!existsSync(file)) return out({ id, error: { code: -32600, message: "no such thread" } });
      thread = JSON.parse(readFileSync(file, "utf8"));
      // Like Codex 0.164, a resumed thread replays the last turn's usage, later on.
      thread.replay = thread.lastTurnId;
      return reply(id, { thread: { id: thread.id }, model: "gpt-fake" });
    }
    case "turn/start": {
      const turn = { id: `turn_${++turnCount}_${randomUUID().slice(0, 8)}`, interrupted: false, model: params.model ?? null, effort: params.effort ?? null, cwd: params.cwd ?? thread.cwd, sandboxPolicy: params.sandboxPolicy ?? null };
      current = turn;
      if (thread.replay) {
        notify("thread/tokenUsage/updated", { threadId: thread.id, turnId: thread.replay, tokenUsage: { last: { inputTokens: 999, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 999 }, total: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } } });
        thread.replay = null;
      }
      // The real server announces the turn around the time it answers.
      notify("turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress" } });
      reply(id, { turn: { id: turn.id, status: "inProgress" } });
      runTurn(turn, params.input?.[0]?.text ?? "").catch((e) => notify("turn/completed", { threadId: thread.id, turn: { id: turn.id, status: "failed", error: { message: String(e) } } }));
      return;
    }
    case "turn/steer": {
      if (!current || current.id !== params.expectedTurnId) return out({ id, error: { code: -32600, message: "no such active turn" } });
      reply(id, { turnId: current.id });
      current.steer?.(params.input?.[0]?.text ?? "");
      return;
    }
    case "turn/interrupt":
      if (current && current.id === params.turnId) current.interrupted = true;
      current?.steer?.(null);
      for (const [key, resolve] of waiting) {
        waiting.delete(key);
        resolve(null);
      }
      return reply(id, {});
    default:
      return out({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

async function runTurn(turn, text) {
  const base = { threadId: thread.id, turnId: turn.id };
  const say = (delta) => notify("item/agentMessage/delta", { ...base, itemId: "msg", delta });
  const end = (status, error) => {
    if (current === turn) current = null;
    notify("turn/completed", { threadId: thread.id, turn: { id: turn.id, status, ...(error ? { error } : {}) } });
  };
  notify("item/reasoning/summaryTextDelta", { ...base, itemId: "r", delta: "thinking" });

  let answer;
  const tool = /\btool (\w+)(?: (\{.*\}))?/.exec(text);
  const mcp = /\bmcp ([\w-]+) (\w+)(?: (\{.*\}))?/.exec(text);
  if (/crash/.test(text)) {
    say("about to crash");
    await sleep(20);
    process.exit(70);
  } else if (/limit/.test(text)) {
    notify("error", { ...base, willRetry: false, error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" } });
    return end("failed", { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" });
  } else if (/^skill /.test(text)) {
    const [, name, file] = text.split(" ");
    const result = await callTool("read_skill", { skill: name, ...(file ? { file } : {}) });
    answer = `${result.isError ? "error: " : ""}${result.text}`;
  } else if (/^developer$/.test(text)) {
    answer = thread.developer ?? "none";
  } else if (mcp) {
    notify("item/started", { ...base, item: { id: "m", type: "mcpToolCall", server: mcp[1], tool: mcp[2] } });
    const result = await callTool(mcp[2], mcp[3] ? JSON.parse(mcp[3]) : {}, mcp[1]);
    answer = `${mcp[1]}.${mcp[2]} said: ${result.text}${result.isError ? " (error)" : ""}`;
  } else if (tool) {
    notify("item/started", { ...base, item: { id: "t", type: "mcpToolCall", server: "edukors", tool: tool[1] } });
    const result = await callTool(tool[1], tool[2] ? JSON.parse(tool[2]) : {});
    answer = `Tool ${tool[1]} said: ${result.text}${result.isError ? " (error)" : ""}`;
  } else if (/\bask\b/.test(text) && !/ask-blocking/.test(text)) {
    const item = { type: "agentMessage", id: "q", text: "Which color?\n- red\n- blue", phase: "final_answer", delivery: "async", questions: [{ title: "Which color?", options: ["red", "blue"] }] };
    notify("item/started", { ...base, item });
    notify("item/completed", { ...base, item });
    notify("item/started", { ...base, item: { type: "sleep", id: "s", durationMs: 43200000 } });
    const steered = await new Promise((resolve) => (turn.steer = resolve));
    if (steered === null || turn.interrupted) return end("interrupted");
    answer = `You chose ${steered}`;
  } else if (/ask-blocking/.test(text)) {
    const res = await askClient("item/tool/requestUserInput", { ...base, itemId: "q", isBlocking: true, questions: [{ id: "color", header: "Color", question: "Which color?", options: [{ label: "red", description: "" }, { label: "blue", description: "" }] }] });
    if (!res || turn.interrupted) return end("interrupted");
    answer = `You chose ${res.answers?.color?.answers?.[0] ?? "nothing"}`;
  } else if (/^sandbox$/.test(text)) {
    answer = JSON.stringify({ threadCwd: thread.cwd ?? null, approvalPolicy: thread.approvalPolicy ?? null, sandbox: thread.sandbox ?? null, turnCwd: turn.cwd ?? null, sandboxPolicy: turn.sandboxPolicy, webSearch: config.web_search ?? null, tmp: process.env.TMPDIR ?? null, processCwd: process.cwd() });
  } else if (/^run /.test(text)) {
    const command = text.slice(4);
    // Approval is asked unless the policy is never, as Codex does.
    const decision = thread.approvalPolicy === "never" ? "accept" : (await askClient("item/commandExecution/requestApproval", { ...base, itemId: "c", command }))?.decision;
    if (decision !== "accept") answer = `Command ${decision}`;
    else {
      const r = spawnSync("/bin/sh", ["-c", command], { cwd: turn.cwd ?? process.cwd(), encoding: "utf8" });
      answer = `exit ${r.status}: ${(r.stdout + r.stderr).trim()}`;
    }
  } else if (/comando/.test(text)) {
    const res = await askClient("item/commandExecution/requestApproval", { ...base, itemId: "c", command: "ls" });
    answer = `Command ${res?.decision}`;
  } else if (/slow|late/.test(text)) {
    for (let i = 0; i < 40; i++) {
      if (turn.interrupted) {
        end("interrupted");
        if (/late/.test(text)) {
          await sleep(30);
          say("LATE OUTPUT");
        }
        return;
      }
      say(".");
      await sleep(50);
    }
    answer = "done slowly";
  } else if (/\benv\b/.test(text)) {
    answer = `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "present" : "absent"} home=${basename(HOME)} sandbox=${thread.sandbox} approval=${thread.approvalPolicy}`;
  } else {
    answer = `Echo: ${text} [history ${thread.turns.length}, model ${turn.model ?? "default"}, effort ${turn.effort ?? "default"}, mcp ${mcpUrl ? "on" : "off"}, instructions ${thread.instructions ?? "none"}]`;
  }
  for (const piece of [answer.slice(0, 10), answer.slice(10)]) if (piece) say(piece);
  thread.turns.push(text);
  thread.lastTurnId = turn.id;
  saveThread();
  notify("thread/tokenUsage/updated", { ...base, tokenUsage: { last: { inputTokens: text.length, outputTokens: answer.length, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: text.length + answer.length }, total: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } } });
  end("completed");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve?.(msg.result ?? null);
    return;
  }
  if (msg.method && msg.id !== undefined) void handle(msg);
});
