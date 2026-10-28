# edukors_ai_cli

`@edukors/ai-cli` connects EDUKORS editors (Slides and Graph) to the AI provider CLIs installed on a user's computer. It gives both editors the same account and session behavior:

1. Choose a provider.
2. Connect an account.
3. Select the account and start working.

The library handles CLI discovery, accounts, provider processes, sessions, interruption, tool routing, normalized events and redacted diagnostics. Each editor keeps its own document state, tools, validation, undo and UI.

> **Status: 0.1.0.** Shared core, Claude and Codex adapters, skills and the user's MCP servers, the stdio host and a deterministic fake provider. Both adapters are verified live (sign-in, isolation of two accounts, tools, questions, interruption, crash recovery); the Graph editor runs on the library. See [docs/compatibility.md](docs/compatibility.md) and [Roadmap](#roadmap).

## Installing

```sh
npm install github:mgarlabx/edukors_ai_cli#v0.1.0
```

npm builds the package on install (`prepare`). Applications pin a tag and commit their lockfile.

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

Every editor's AI settings screen has the same layout (see section 6 of `edukors_ai_cli_plan.md`): **Accounts** at the top, and under **Advanced** always *Instructions for the agent*, *MCP servers* and *Skills*. `parseMcpConfig(text)` validates the MCP JSON (`{ "mcpServers": { ... } }` or the bare object, `timeout` in milliseconds) and returns every problem as a stable code; `listSkills(dir)` lists the skills folder for display.

The library connects to the user's servers itself and offers their tools to either provider. A provider is never handed a server directly: every call goes through `authorize`, and is reported as `toolStarted`/`toolCompleted` (`mcp__<server>__<tool>`). Without `authorize`, such calls are denied. Server status is reported once as `mcpServerStatus` events.

Claude Code loads the skills natively, through a local plugin. Codex would need shell commands to read them, so the library serves them through a `read_skill` tool confined to each skill's folder, and lists them in the session's developer instructions. In both cases the provider's own skills and the user's personal ones are switched off.

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

## Roadmap

Follows `edukors_ai_cli_plan.md`:

- [x] Phase 2: shared core, fake provider, contract tests, stdio host.
- [x] Phase 1 (offline part): compatibility matrix in `docs/compatibility.md`.
- [x] Phase 3 (offline part): Claude and Codex adapters, tested against fakes and against the real CLIs signed out.
- [x] Phases 1 and 3 (live part): sign-in, turns and isolation with two real accounts per provider.
- [x] Phase 4: Graph integration (on the Graph editor's `ai-cli-integration` branch).
- [ ] Phase 5: Slides integration.
- [ ] Phase 6: remaining providers, Windows/Linux verification, release.

## License

MIT. See [LICENSE](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
