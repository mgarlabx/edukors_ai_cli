#!/usr/bin/env node
/**
 * `edukors-ai`: the library from a terminal, for trying it without either
 * editor. It uses the same engine, registry and adapters the editors use.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createAiCli, type AiCli } from "../engine.js";
import { isAiCliError } from "../errors.js";
import { bundledProviders } from "../providers.js";
import { defineTool } from "../tools.js";

const USAGE = `usage: edukors-ai [--data-dir <dir>] [--fake] <command>

  providers                      installed providers and their capabilities
  accounts                       accounts in the shared registry
  add <provider> [label]         register an account
  rename <account> <label>       change an account's label
  remove <account> [--delete-data]
  connect <account>              sign in
  status <account>               sign-in state, without a model request
  logout <account>
  models <account>
  chat <account> [--document <id>] [--model <id>]
  diagnostics                    redacted diagnostic report (JSON)

<account> is an account id or label. --fake enables the test provider.
In chat, Ctrl+C stops the current request; Ctrl+D or /exit leaves.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    "app-id": { type: "string", default: "cli" },
    fake: { type: "boolean", default: false },
    document: { type: "string", default: "scratch" },
    model: { type: "string" },
    "delete-data": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...args] = positionals;
if (!command || values.help) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
}

const ai = createAiCli({
  appId: values["app-id"]!,
  providers: bundledProviders({ fake: values.fake }),
  ...(values["data-dir"] ? { dataDir: values["data-dir"] } : {}),
  logSink: (e) => {
    if (values.verbose) process.stderr.write(`[${e.level}] ${e.scope}: ${e.message}\n`);
  },
});

async function findAccount(ref: string | undefined) {
  if (!ref) throw new Error("an account is required");
  const accounts = await ai.listAccounts();
  const found = accounts.find((a) => a.id === ref) ?? accounts.filter((a) => a.label.toLowerCase() === ref.toLowerCase()).at(0);
  if (!found) throw new Error(`no account "${ref}"`);
  return found;
}

const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function main(): Promise<void> {
  switch (command) {
    case "providers": {
      if (ai.providers().length === 0) return print("No providers are available yet. Use --fake to try the test provider.");
      for (const d of await ai.detectAll()) {
        const caps = d.status === "ready" ? await ai.capabilities(d.providerId) : null;
        print(`${d.providerId}\t${d.status}${d.version ? ` ${d.version}` : ""}${d.requiredVersion ? ` (needs ${d.requiredVersion})` : ""}`);
        if (caps) print(`\t${Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k).join(", ")}; login: ${caps.login}`);
      }
      return;
    }
    case "accounts": {
      const accounts = await ai.listAccounts();
      if (accounts.length === 0) return print("No accounts.");
      for (const a of accounts) print(`${a.id}\t${a.providerId}\t${a.label}${a.supported ? "" : "\t(provider not available here)"}`);
      return;
    }
    case "add":
      return print(await ai.createAccount({ providerId: args[0] ?? "", label: args.slice(1).join(" ") }));
    case "rename":
      return print(await ai.renameAccount((await findAccount(args[0])).id, args.slice(1).join(" ")));
    case "remove":
      await ai.removeAccount((await findAccount(args[0])).id, { deleteData: values["delete-data"] });
      return print("Removed. Other EDUKORS applications on this computer no longer list it.");
    case "connect":
      return connect((await findAccount(args[0])).id);
    case "status":
      return print(await ai.accountStatus((await findAccount(args[0])).id));
    case "logout":
      await ai.logoutAccount((await findAccount(args[0])).id);
      return print("Signed out.");
    case "models":
      return print(await ai.listModels((await findAccount(args[0])).id));
    case "diagnostics":
      return print(await ai.diagnosticReport());
    case "chat":
      return chat(ai, (await findAccount(args[0])).id);
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

/**
 * Signs in. The browser normally finishes on its own; when it does not open,
 * the address is shown here and, for providers that end with a code, the code
 * typed (or piped) on the next line is passed on.
 */
async function connect(accountId: string): Promise<void> {
  let rl: ReturnType<typeof createInterface> | null = null;
  try {
    const status = await ai.connectAccount(accountId, {
      onLogin: ({ url, acceptsCode }) => {
        console.error(`\nIf the browser did not open, sign in at:\n${url}\n`);
        if (!acceptsCode) return;
        rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
        rl.setPrompt("Paste the code shown after signing in (or finish in the browser): ");
        rl.prompt();
        rl.once("line", (line) => {
          try {
            if (line.trim()) ai.submitLoginCode(accountId, line);
          } catch (e) {
            console.error(isAiCliError(e) ? `[${e.code}] ${e.message}` : String(e));
          }
        });
      },
    });
    print(status);
  } finally {
    (rl as ReturnType<typeof createInterface> | null)?.close();
  }
}

/** A small in-memory document, so tool calls can be tried from the terminal. */
function demoTools(paragraphs: string[]) {
  return [
    defineTool({
      name: "read_document",
      description: "Returns the document's paragraphs, numbered.",
      input: z.object({}),
      run: () => ({ content: paragraphs.map((p, i) => `${i + 1}. ${p}`).join("\n") || "(empty)" }),
    }),
    defineTool({
      name: "append_paragraph",
      description: "Adds a paragraph at the end of the document.",
      input: z.object({ text: z.string().min(1) }),
      run: ({ text }) => {
        paragraphs.push(text);
        return { content: `Added paragraph ${paragraphs.length}.` };
      },
    }),
  ];
}

async function chat(ai: AiCli, accountId: string): Promise<void> {
  const paragraphs: string[] = [];
  const session = await ai.openSession({
    accountId,
    documentId: values.document!,
    instructions: "You are helping edit a short document through the read_document and append_paragraph tools.",
    tools: demoTools(paragraphs),
    ...(values.model ? { options: { model: values.model } } : {}),
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let busy = false;
  const questions: string[] = [];
  /** Resolves when the current request ends or asks something. */
  let wake: (() => void) | null = null;

  session.on((e) => {
    switch (e.type) {
      case "textDelta":
        process.stdout.write(e.text);
        break;
      case "activity":
        process.stderr.write(`\x1b[2m[${e.phase}]\x1b[0m `);
        break;
      case "toolStarted":
        process.stderr.write(`\x1b[2m[tool ${e.tool}]\x1b[0m `);
        break;
      case "toolCompleted":
        if (!e.ok) process.stderr.write(`\x1b[33m[${e.tool} failed: ${e.errorCode}]\x1b[0m `);
        break;
      case "question":
        questions.push(e.questionId);
        process.stdout.write(`\n? ${e.prompt}${e.options ? ` (${e.options.join(" / ")})` : ""}\n`);
        wake?.();
        break;
      case "usageUpdated":
        process.stderr.write(`\x1b[2m[tokens in ${e.usage.inputTokens ?? "?"}, out ${e.usage.outputTokens ?? "?"}]\x1b[0m`);
        break;
      case "error":
        process.stderr.write(`\n\x1b[31m[${e.error.code}] ${e.error.message}\x1b[0m`);
        break;
      case "cancelled":
        process.stderr.write("\n[stopped]");
        break;
    }
  });

  rl.on("SIGINT", () => {
    if (busy) void session.interrupt();
    else rl.close();
  });

  const prompt = () => {
    rl.setPrompt(questions.length ? "answer> " : "\n> ");
    rl.prompt();
  };

  print(`Session ${session.id} on document "${values.document}". Type /exit to leave.`);
  prompt();
  // Lines typed (or piped) while a request runs are buffered by the iterator.
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/exit") break;
    const question = questions.shift();
    if (question) session.answer(question, line);
    else if (line) {
      busy = true;
      void session.send(line).finally(() => {
        busy = false;
        wake?.();
      });
    }
    if (busy) await new Promise<void>((resolve) => (wake = resolve));
    wake = null;
    if (!busy) process.stdout.write("\n");
    prompt();
  }
  rl.close();
}

try {
  await main();
} catch (e) {
  console.error(isAiCliError(e) ? `[${e.code}] ${e.message}` : e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await ai.dispose();
}
