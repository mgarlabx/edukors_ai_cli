<h1 align="center">Edukors AI CLI</h1>

<p align="center">
  The shared library that connects the Edukors editors to the AI provider CLIs<br>
  installed on the user's computer (<strong>Claude Code</strong> and <strong>Codex</strong>).<br>
  Part of the <a href="https://edukors.org"><strong>Edukors.org</strong></a> project.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@edukors/ai-cli"><img src="https://img.shields.io/npm/v/@edukors/ai-cli?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=CB3837" alt="npm package"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?logo=node.js&logoColor=white" alt="Node.js 22.12 or later">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

<p align="center">
  <sub>Published on npm as <code>@edukors/ai-cli</code>. Tested on macOS; Linux and Windows code paths exist but have not been verified yet.</sub>
</p>

## Part of Edukors.org

[Edukors.org](https://edukors.org) is a free, nonprofit effort that helps educators anywhere in the world learn to work with artificial intelligence. Its editors let teachers build course material with an AI agent alongside, and this library is the piece they share for that agent:

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🗺️ Graph Editor</h3>
      <a href="https://github.com/mgarlabx/edukors_graph_editor">edukors_graph_editor</a>: adaptive courses in the <a href="https://github.com/mgarlabx/edukors_graph">Edukors Graph</a> format.
    </td>
    <td width="33%" valign="top">
      <h3>🖼️ Slides Editor</h3>
      <a href="https://github.com/mgarlabx/edukors_slides_editor">edukors_slides_editor</a>: presentations, kept as folders of files.
    </td>
    <td width="33%" valign="top">
      <h3>🤖 AI CLI</h3>
      <strong>This library</strong>, which gives both editors the same AI accounts, sessions and agent behavior.
    </td>
  </tr>
</table>

With it, every editor offers the same three steps:

1. Choose a provider.
2. Connect an account.
3. Select the account and start working.

The library handles CLI discovery, accounts, provider processes, sessions, interruption, tool routing, normalized events and redacted diagnostics. Each editor keeps its own document state, tools, validation, undo and UI.

## What it provides

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🔌 Providers</h3>
      Finds the user's own <code>claude</code> and <code>codex</code> CLIs and drives them; it never downloads them.
    </td>
    <td width="33%" valign="top">
      <h3>👤 Accounts</h3>
      Several accounts per provider, each with its own sign-in, shared by every Edukors app on the computer.
    </td>
    <td width="33%" valign="top">
      <h3>💬 Sessions</h3>
      Conversations per document, with interruption, crash recovery and resume.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>🛠️ Tools</h3>
      The editor's own tools, validated with zod, so the document changes only through the editor.
    </td>
    <td width="33%" valign="top">
      <h3>🧩 Skills and MCP</h3>
      The user's skills and MCP servers, with every MCP call going through the editor's approval.
    </td>
    <td width="33%" valign="top">
      <h3>📁 Workspace</h3>
      An agent that works inside a document's folder, confined to it.
    </td>
  </tr>
</table>

## Installing

```sh
npm install @edukors/ai-cli@0.2.0
```

Applications pin an exact version and commit their lockfile; a release of the library changes no installed application.

## Requirements

- Node.js 22.12 or later.
- macOS is the tested platform. Linux and Windows code paths exist but have not been verified yet.

## Try it without an editor

```sh
npm install
npm test                     # the full suite, no accounts needed
npm run build

# Claude and Codex are always available (they need the user's own CLI installed).
# The fake provider is a real separate CLI process (fixtures/fake-ai.mjs).
alias ai="node dist/cli/main.js --fake --data-dir .sandbox"
ai providers
ai add fake Personal
ai connect Personal
ai status Personal
ai chat Personal --document lesson-1
```

In `chat`, the fake provider responds to keywords: `tool append_paragraph {"text":"Hi"}`, `tool read_document`, `ask`, `slow` (press Ctrl+C to interrupt), `crash`, `rate-limit`, `env`. Anything else is echoed. The full list is at the top of `fixtures/fake-ai.mjs`.

Without `--data-dir`, the shared per-user directory is used: `~/Library/Application Support/EDUKORS` on macOS, `%LOCALAPPDATA%\EDUKORS` on Windows, `$XDG_DATA_HOME/edukors` on Linux. You can also set it with `EDUKORS_AI_DATA_DIR`.

## Using the library

```ts
import { createAiCli, defineTool } from "@edukors/ai-cli";
import { z } from "zod";

const ai = createAiCli({ appId: "graph", providers: [/* adapters */] });

const [detection] = await ai.detectAll();          // ready | missing | incompatible | error
const account = await ai.createAccount({ providerId: "claude", label: "Work" });
await ai.connectAccount(account.id);                // the provider's own sign-in flow

const session = await ai.openSession({
  accountId: account.id,
  documentId: course.id,
  instructions: "You edit the course on screen.",
  tools: [
    defineTool({
      name: "set_title",
      description: "Sets the course title.",
      input: z.object({ title: z.string().min(1) }),
      run: ({ title }, { signal }) => store.setTitle(title), // the editor validates and applies
    }),
  ],
});

session.on((event) => ui.handle(event));            // textDelta, activity, question, toolStarted, ...
const result = await session.send("Rename the course", { context: latestDocumentState });
await session.interrupt();                          // committed edits stay; later output is dropped
```

### Skills and the user's MCP servers

```ts
const session = await ai.openSession({
  accountId, documentId, tools,
  skillsDir: "/abs/path/to/skills",          // <name>/SKILL.md; no other skill is enabled
  mcpServers: { glossary: { command: "npx", args: ["glossary-mcp"] } },  // or { type: "http" | "sse", url }
  authorize: async ({ server, tool, input }) => (await ui.confirm(`${server}: ${tool}`)) ? { allow: true } : { allow: false, message: "Declined." },
});
```

Every editor's AI settings screen has the same layout (see [docs/roadmap.md](docs/roadmap.md#settings-screen)): **Accounts** at the top, and under **Advanced** always *Instructions for the agent*, *MCP servers* and *Skills*. `parseMcpConfig(text)` validates the MCP JSON (`{ "mcpServers": { ... } }` or the bare object, `timeout` in milliseconds) and returns every problem as a stable code; `listSkills(dir)` lists the skills folder for display.

The library connects to the user's servers itself and offers their tools to either provider. A provider is never handed a server directly: every call goes through `authorize`, and is reported as `toolStarted`/`toolCompleted` (`mcp__<server>__<tool>`). Without `authorize`, such calls are denied. Server status is reported once as `mcpServerStatus` events.

Claude Code loads the skills natively, through a local plugin. Codex would need shell commands to read them, so the library serves them through a `read_skill` tool confined to each skill's folder, and lists them in the session's developer instructions. In both cases the provider's own skills and the user's personal ones are switched off.

### Workspace: an agent that works in a folder

An editor whose documents are folders of files (the Slides editor's presentations) can let the agent work there with the provider's own tools:

```ts
const session = await ai.openSession({
  accountId, documentId, tools,
  workspace: {
    dir: "/abs/path/to/presentation",     // the agent's working directory
    readDirs: ["/abs/path/to/attachments"], // read-only extras
    protect: ["manifest.json", "slides"],   // the application's own files: read, never written
    web: true,                              // web search and fetch (default true)
    shell: true,                            // commands, where a sandbox confines them (default true)
  },
});
```

The agent reads only the workspace, its `readDirs` and what the system needs; it writes only the workspace, never a protected path; nothing else of the user's is in reach. The application's own files still change only through its tools, which validate them.

| Provider | Files | Web | Commands | Confinement |
| --- | --- | --- | --- | --- |
| Claude | ✓ | ✓ | macOS, Linux | Claude Code's `--restricted` mode, permission rules, and its sandbox for commands (`failIfUnavailable`). Native Windows: files and web only (`workspaceShell: false`) |
| Codex | ✓ | ✓ | macOS | The macOS system sandbox around the app server; Codex runs its commands as in an external sandbox. Not offered elsewhere (`workspace: false`), since Codex's own sandbox cannot keep reads in the folder |

Check `capabilities.workspace` and `capabilities.workspaceShell` before offering the choice. Asking for a workspace where the provider has none fails with `CAPABILITY_UNSUPPORTED`; asking for commands where it cannot confine them gives a workspace without commands.

### Guarantees

- **Scoped events.** Every event carries `appId`, `documentId`, `accountId`, `providerId` and `sessionId`. Events tied to a request also carry `requestId`.
- **No late output.** Once a request is interrupted, finished or replaced, any output the provider still sends is dropped. It never reaches the document, and no tool runs after cancellation. This is enforced by the library, not left to each adapter.
- **Recovery.** If a provider crashes, the request fails with `PROVIDER_CRASHED`. The next request restarts the provider and resumes the conversation when the provider supports it. A provider that ignores an interruption is shut down after a grace period.
- **Stable errors.** Every failure has a code from `ERROR_CODES` with structured metadata. Raw provider text goes only to diagnostics.
- **Honest capabilities.** Missing features (usage, models, logout, multiple accounts, ...) show up as capabilities and `CAPABILITY_UNSUPPORTED` errors. They are never simulated, and unknown usage is reported as unknown, not zero.
- **Isolated environment.** Provider processes get an allowlisted environment, so inherited credentials such as `ANTHROPIC_API_KEY` cannot override the selected account.

### Accounts and the shared registry

Accounts live in `<data dir>/ai/registry.json` and are shared by every EDUKORS application of the same OS user. The registry holds only non-secret metadata: an immutable id, the provider, a label, and a reference to a managed directory. Credentials stay where the provider keeps them, inside that account's managed directory or the provider's own secure storage.

Writes are atomic (temporary file, flush, rename) and serialized across processes by a lock directory. The lock is refreshed while held and taken over if its owner dies. A library version never rewrites a registry whose `schemaVersion` it doesn't know, and preserves unknown fields when it does write.

Sessions are not shared. Their scratch space is under `ai/sessions/<appId>/<document hash>/<accountId>`.

Removing an account affects every editor on the computer. `removeAccount` removes the account from the registry. `logoutAccount` signs it out at the provider.

## Application-host protocol

`edukors-ai-host --app-id graph` exposes the library over stdin/stdout, one JSON object per line. The Tauri editor runs it as a sidecar, and the Electron editor can run it in a worker process. The message shapes are documented at the top of `src/host/stdio.ts`. Tools are declared with JSON Schema in `session.open`, and the host calls back into the application with `tool.call`.

```sh
printf '{"id":1,"method":"providers.detect"}\n' | node dist/host/main.js --app-id graph --fake --data-dir .sandbox
```

## Writing a provider adapter

Implement `ProviderAdapter` (see `src/provider.ts`). `src/testing/fakeProvider.ts` is a complete reference: short commands for detection, sign-in and status; a long-running process for the session; zod validation of everything read from the CLI; and `hooks.exited` for crashes. An adapter must:

- build its process environment with `buildEnv`, setting only that account's variables;
- use `ManagedProcess`/`runCommand`, never bare `spawn`, so timeouts, bounded output and process-tree cleanup apply;
- settle a pending `send` when `close()` is called or the process exits;
- report only the capabilities it has verified.

## Layout

| Path | Contents |
| --- | --- |
| `src/engine.ts` | `AiCli`: providers, accounts, sessions, diagnostics |
| `src/session.ts` | Session lifecycle, late-event guard, tool routing, questions, recovery |
| `src/provider.ts` | The adapter contract |
| `src/events.ts`, `src/errors.ts` | Normalized events and stable error codes |
| `src/tools.ts` | Application tool definitions (`defineTool`) |
| `src/registry/` | Shared account registry and cross-process lock |
| `src/platform/` | Data paths, environment, CLI discovery, process management |
| `src/host/` | stdio application-host protocol and executable |
| `src/cli/` | `edukors-ai` terminal tool |
| `src/providers/claude/`, `src/providers/codex/` | Provider adapters |
| `src/mcp/` | MCP servers: the application's tools (in-process or local HTTP bridge) and the user's servers (client) |
| `src/skills.ts` | Skill folders: listing, confined reading, `read_skill` |
| `src/testing/`, `fixtures/` | Fake provider adapter and fake CLIs (`fake-ai`, `fake-claude`, `fake-codex`) |

## Project status

Version 0.2.0: the shared core, the Claude and Codex adapters, skills and the user's MCP servers, the workspace mode, the stdio host and a deterministic fake provider. Both adapters are verified live (sign-in, isolation of two accounts, tools, questions, interruption, crash recovery), and the Graph editor and the Slides editor run on the library. See [docs/compatibility.md](docs/compatibility.md).

What is left (the remaining providers, Codex connectors, a bundled Node.js for the Graph editor, live checks on Windows and Linux), the design rules both editors follow and what is out of scope are in [docs/roadmap.md](docs/roadmap.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Edukors.org - Maurício Garcia and contributors.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
