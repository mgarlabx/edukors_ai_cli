# Changelog

## 0.2.2

- `PROVIDER_CATALOG` and `installationCommand(provider, platform)`, exported from the main entry and from `@edukors/ai-cli/settings` (safe for renderers): each provider's name, CLI and official guide, and the install command per platform. The adapters' `installUrl` comes from the catalog.
- New package `@edukors/ai-ui` 0.1.4 (`packages/ui`): the React 19 interface both editors share (accounts, provider setup, model and effort, usage, conversations, questions, headers), in Portuguese, English and Spanish. See [docs/assistant-interface.md](docs/assistant-interface.md).

## 0.2.0

- Workspace: `openSession({ workspace: { dir, readDirs, protect, web, shell } })` lets the agent work in a folder with the provider's own file and web tools, and commands where a sandbox confines them; it never writes a protected path and reaches nothing else of the user's. New capabilities `workspace` and `workspaceShell`. Claude: everywhere, commands on macOS and Linux. Codex: macOS, inside the system sandbox. Host: `session.open` takes `workspace`.
- Fake provider: `workspace`, `write` and `read` turns, and the `workspaceShell` option.

## 0.1.1

- First version published to npm. The executables (`edukors-ai`, `edukors-ai-host`) are declared without a leading `./`, which npm would otherwise drop.

## 0.1.0 (not published to npm)

- Provider adapter contract, normalized events and stable error codes.
- Shared, versioned account registry with atomic writes and cross-process locking.
- Session lifecycle: tool routing with validation, questions, interruption with grace period, late-event dropping, crash recovery with resume.
- CLI discovery, allowlisted process environment, process-tree termination, bounded output, redacted diagnostics.
- stdio application-host protocol (`edukors-ai-host`) and terminal tool (`edukors-ai`).
- Fake provider CLI and adapter for deterministic tests.
- Claude adapter (Agent SDK driving the user's `claude`, one `CLAUDE_CONFIG_DIR` per account, in-process MCP tools, `AskUserQuestion` only by default).
- Codex adapter (`codex app-server`, one `CODEX_HOME` per account, tools over an authenticated 127.0.0.1 MCP bridge passed with `-c`, commands declined, skills off).
- Compatibility matrix (`docs/compatibility.md`).
- Sign-in without a working browser: `connectAccount` reports the provider's sign-in address through `onLogin`, and `submitLoginCode` passes a pasted code to the waiting CLI (host: `login` message and `accounts.submitCode`; terminal: `edukors-ai connect` asks for the code).
- Codex: questions in Codex 0.164's async form are answered through `turn/steer`; a resumed thread's replayed notifications no longer capture the next request; status names the account (`account/read`).
- Skills: `skillsDir` offers an application's skills (Claude natively, Codex through `read_skill`); every other skill is off.
- The user's MCP servers: `mcpServers` + `authorize`; the library connects to them and re-serves their tools, every call authorized and reported (`mcpServerStatus`, `TOOL_DENIED`). Host: `session.open` takes both, and asks the app with `tool.authorize`.
- Settings helpers: `parseMcpConfig` (every problem as a stable code) and `listSkills`. MCP server specs use `timeout` in milliseconds, as `.mcp.json` does.
- Usage reports every limit window (`windows`), the most used one as `limitUsed`.
