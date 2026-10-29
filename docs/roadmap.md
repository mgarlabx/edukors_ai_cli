# Roadmap and design rules

What `edukors_ai_cli` is for, the rules both editors follow, and what is left to do. It replaces the original implementation plan, whose phases 1 to 5 are done; their results are described in the [README](../README.md) and in [compatibility.md](compatibility.md).

## Purpose

One AI connection experience for the EDUKORS editors (the Slides editor, Electron, and the Graph editor, Tauri): choose a provider, connect an account, select it and work. People never need to know executable paths, configuration folders, environment variables, protocols or terminal commands; advanced settings stay available.

- Three independent public repositories: this library (provider adapters, accounts, processes, sessions, capabilities, normalized events), `edukors_slides_editor` and `edukors_graph_editor` (their own UI, document validation, tools, undo and instructions).
- The library is published as a versioned package (`@edukors/ai-cli`) and pinned by each editor; a library release never changes an installed editor by itself. No submodules, no copied sources, no hosted service or daemon.
- The core stays independent of Electron, Tauri, React and the editors' document formats. Editors embed it in-process or run its stdio host.
- Provider CLIs are the user's own installation: discovered, never downloaded or updated silently.
- Everything in this repository is in English; editors localize what people see.

## Accounts

- Several accounts of one provider are a first-class feature, offered only where isolation is verified (see compatibility.md). Each account has an immutable ID, a label, a provider and its own managed home.
- Provider installation, account and session are separate things. A session belongs to one account, one document and one application.
- The registry is per operating-system user, shared by every EDUKORS application, versioned, written atomically under a cross-process lock, and safe across different library versions.
- Credentials stay in the provider's own storage; the registry holds references and non-secret metadata only. Inherited credentials never override the selected account.
- Removing or signing out a shared account affects every editor, and the UI says so. Switching accounts starts a new session; an old session identifier is never reused across accounts.

## Settings screen

Every editor's AI settings screen has the same sections, with the same names and behavior. **Accounts** comes first, at the top level. **Advanced** groups the rest and always contains instructions, MCP servers and skills (sections 2–4, in this order), followed by executable overrides, account directory overrides and detailed model controls. Users who learn them in one editor find them in the same place in the other.

1. **Accounts**: the provider accounts in the shared registry. Add (choose a provider, name the account, sign in), status with identity, reconnect, sign out, and remove (stating that removal affects every EDUKORS application). During sign-in, show the provider's address as a fallback and, when the provider ends with a code, a field to paste it; the field states that it wants the code shown after authorizing, not an e-mail verification code. Usage per account, with its windows and freshness, where available.
2. **Instructions for the agent**: free text the user writes once, applied to every session of that editor, after the editor's own instructions and before its scope rules, which it can never override.
3. **MCP servers**: the user's own servers, as JSON in the common `{ "mcpServers": { "<name>": { "command", "args", "env" } | { "type": "http" | "sse", "url", "headers" } } }` format. Validate on input with `parseMcpConfig` and show each problem next to the field; after a session opens, show each server's connection status and tool count. Every call to these servers asks the user unless the editor's mode allows it, explaining the action, never a raw command.
4. **Skills**: the skills in the editor's own skills folder (`<name>/SKILL.md`), each with its name and description, with "Open skills folder" and "Reload", and "No skills installed." when empty. Only these skills are offered; the provider's bundled skills and the user's personal ones never are.

Settings 2–4 belong to the editor; accounts are shared. The library supplies `parseMcpConfig`, `listSkills` and the session options `instructions`, `mcpServers`, `skillsDir` (and `workspace` for editors whose documents are folders).

Progress uses common states (preparing, thinking, reading, researching, applying, done), never raw protocol names or shell commands. Usage is shown only when known, with its time; unknown usage is "not available", never zero.

## Document changes and permissions

- The AI changes a document only through the editor's own tools; the editor validates each proposal and applies it through its normal state, as one undo step. Stop cancels further work; what was already applied stays visible and undoable; late results are never applied.
- Every request carries the latest document state, unsaved manual edits included.
- Default policy: scoped reads of the active document and attachments, ordinary reversible edits, the editor's own rules for destructive ones, file access limited to the needed workspace. The user's MCP servers and skills are opt-in, every MCP call is authorized.
- Confinement is enforced at tool boundaries and by process isolation, never by prompts alone. A capability a platform cannot confine is turned off on that platform and reported as such.

## Security, diagnostics and releases

- No credentials in repositories, documents, logs or diagnostics; local tool transports authenticated and bound to 127.0.0.1; protocol messages and tool arguments validated; output bounded; process trees always terminated.
- Supported provider interfaces over private endpoints or credential inspection; usage unavailable rather than guessed.
- Diagnostics carry versions, platform, capabilities and redacted errors, never documents or credentials.
- The library, the host protocol and the registry schema are versioned explicitly; changelogs state provider compatibility and any reconnect action. Rollback to a tested editor release must never be silently destructive. Real credentials never go into CI; live checks run locally.

## Still to do

- **Phase 6: the remaining providers.** Bring Kimi, Kiro, OpenCode and Antigravity (removed from both editors in the move to this library) as adapters on the same contract. Verify capabilities, sign-in, account isolation and each platform for every one; hide combinations that are not supported and document the limits; retire what is left of the editors' own provider code.
- **Codex connectors.** Every Codex session also starts a `codex_apps` MCP server (the ChatGPT account's connectors), offered to the model outside the editor's control. Find the supported switch, check that an unknown `-c` key does not stop the app server, and turn it off by default (see compatibility.md → Open issues).
- **Node.js for the Graph editor.** The Graph editor's agent still needs Node.js installed on the computer; bundle the runtime its host needs.
- **Windows and Linux, live.** The workspace mode and both adapters are covered by CI on all three systems with fakes; live checks with real accounts have run on macOS only.

## Out of scope

- Hosting AI inference or replacing provider subscriptions.
- Synchronizing credentials or conversations across computers.
- Guaranteeing identical capabilities or model behavior across providers.
- Preserving every legacy technical session format.
- Installing or updating provider CLIs automatically.
