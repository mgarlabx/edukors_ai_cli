# Provider compatibility

Status of each provider adapter: what it relies on, and how far each part has been verified. Update this file whenever a CLI version, a protocol shape or a verification result changes.

**Verification levels**

- **Offline**: covered by the automated suite against a fake CLI that reproduces the protocol (`fixtures/`, `test/fakeClaudeSdk.ts`).
- **Real CLI, signed out**: run against the real CLI on macOS with a new, empty account directory. No sign-in, no prompt, no tokens spent.
- **Live**: run against the real CLI with signed-in accounts. Claude: done on 2026-10-28 (macOS arm64, Claude Code 2.1.312, two different accounts: a personal organization and a Team organization). Codex: pending.

## Versions

| Component | Version checked | Minimum enforced |
| --- | --- | --- |
| Claude Code (`claude`) | 2.1.312 | 2.1.0 (inherited from the Graph editor) |
| Claude Agent SDK | 0.3.287 | pinned in `package.json` |
| Codex CLI (`codex`) | 0.164.0 | 0.164.0 (the version whose app-server schema was checked) |
| MCP TypeScript SDK | 1.31.0 | |

The Codex protocol shapes come from `codex app-server generate-json-schema --experimental` for 0.164.0. Older Codex versions are refused until they are checked.

The Agent SDK installs a bundled Claude Code as an optional dependency (`@anthropic-ai/claude-agent-sdk-<platform>`, about 217 MB on macOS arm64). The adapter never uses it: it always runs the user's own `claude` (`pathToClaudeCodeExecutable`). Applications can leave it out of their packages.

## Claude

| Area | Mechanism | Verified |
| --- | --- | --- |
| Discovery | `claude` on PATH, common install dirs, `~/.claude/local`, login shell; `EDUKORS_CLAUDE` or the `executable` option overrides; Windows `.cmd` shim resolved to `claude.exe`/`cli.js` | Offline; real CLI (macOS) |
| Account isolation | `CLAUDE_CONFIG_DIR` = the account's managed directory. On macOS, Claude Code keys its Keychain entry by that directory (`Claude Code-credentials-<sha256(dir)[0:8]>`, as found in the Slides editor) | **Live**: two accounts with different identities ran at the same time on the same document id, each process reporting its own account; signing one out left the other connected; the user's own `~/.claude` sign-in stayed unchanged throughout, including when one test account used the same identity |
| Inherited credentials | Allowlisted environment; `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR` etc. never inherited | Offline |
| Sign-in | `claude auth login --claudeai` (browser), up to 10 min, cancellable | **Live**: works without a terminal; the browser opens and the command returns when the sign-in completes. The browser reuses a signed-in claude.ai session, so choosing another identity means signing out there first. **Gap:** when the browser does not open, Claude Code prints a URL whose flow ends in a code to paste into the terminal; the adapter has no stdin channel for it yet (see below) |
| Status (no model call) | `claude auth status --json`: exits 1 when signed out, still printing JSON (`loggedIn`); signed in, `email`, `orgName`, `subscriptionType` | **Live** |
| Sign-out | `claude auth logout` | **Live** (the other account stayed connected) |
| Models | `initializationResult().models` from a query with no prompt | Real CLI, signed out (`default, opus, fable, sonnet, haiku`) |
| Session | Agent SDK `query()` in streaming-input mode, `cwd` = per-document work dir, `settingSources: []`, `strictMcpConfig`, `persistSession`, `includePartialMessages` | **Live** (a short turn takes 2–3 s including startup) |
| Sign-in check at open | `initializationResult().account` (email, subscription, token source) | **Live**, signed in and signed out |
| Tools | In-process MCP server (`mcpServers` of type `sdk`) built from the application's JSON Schemas; every call allowed by `canUseTool` and validated by the core. No blanket `allowedTools` entry: the SDK warns that one would bypass `canUseTool` | **Live** |
| Built-in tools | Only `AskUserQuestion` (configurable). Everything else is denied in `canUseTool`. No shell, files, web, skills, personal MCP servers | Offline |
| Questions | `AskUserQuestion` through `canUseTool`, answers returned as `updatedInput.answers` keyed by question text | **Live** (Claude used the answer) |
| Interrupt | `Query.interrupt()`; the turn ends with `terminal_reason: aborted_*` | **Live**: stopped mid-stream, no event of the cancelled request reached the application afterwards, the next request worked |
| Resume | `resume: <session id>` after a crash or a later reopen | **Live**: after `kill -9` of Claude Code, the error was reported at once and the next request resumed the same conversation with its history |
| Usage | Per turn: tokens and cost from `result`; account limits from `rate_limit_event.rate_limit_info.unifiedWindows` (`five_hour`, `seven_day`; utilization already 0–1), the most used leading as `limitUsed` | **Live**. The top-level `utilization` covers only `rateLimitType` and is sometimes absent, which is why the windows are read instead. `readUsage` is reported unsupported: no structured, model-free source |
| Model / effort change | `setModel`, `applyFlagSettings({ effortLevel })` | **Live** (model); effort offline |
| Errors | `authentication_failed` → `ACCOUNT_EXPIRED`, `rate_limit` → `RATE_LIMITED`, `overloaded`/`server_error` → retryable `PROVIDER_ERROR` | Offline |

## Codex

| Area | Mechanism | Verified |
| --- | --- | --- |
| Discovery | `codex` on PATH, common install dirs, login shell; `EDUKORS_CODEX` or the `executable` option overrides | Offline; real CLI (macOS) |
| Account isolation | `CODEX_HOME` = the account's managed directory; Codex keeps `auth.json` there. The user's `~/.codex` is never read or copied (the Graph editor copied `auth.json`; the plan forbids it) | Offline. **Live: pending** (two accounts at once; whether a keyring credential store changes this) |
| Inherited credentials | Allowlisted environment; `OPENAI_API_KEY`, `CODEX_HOME` etc. never inherited | Offline |
| Sign-in | `codex login` (browser), up to 10 min, cancellable | Offline. **Live: pending**, including without a terminal |
| Status (no model call) | `codex login status`: exit 0 signed in; exit 1 and "Not logged in" signed out | Real CLI, signed out. No identity: the command does not print one |
| Sign-out | `codex logout` | Offline |
| Models | `model/list` on a short-lived app server; hidden models filtered | Real CLI, signed out |
| Usage | `account/rateLimits/read`: most-used window as `limitUsed`, with reset time; also `account/rateLimits/updated` and `thread/tokenUsage/updated` during turns | Offline. **Live: pending** |
| Session | `codex app-server`, one process per session, `initialize` with `experimentalApi`, `account/read`, then `thread/start` (`sandbox: read-only`, `approvalPolicy: untrusted`, `baseInstructions`) or `thread/resume` | Real CLI, signed out (starts, initializes, reports the account). **Live turn: pending** |
| Tools | MCP over HTTP on 127.0.0.1, random port, per-session bearer token in `EDUKORS_MCP_TOKEN`; configured with `-c mcp_servers.edukors.*` so no config file is shared between documents | Offline (also: refuses requests without the token). **Live: pending** |
| Commands, file changes, extra permissions | Declined | Offline |
| Skills | Codex's own and the user's (`~/.agents`) turned off in the account's config via `skills/config/write` | Offline. **Live: pending** |
| Questions | `item/tool/requestUserInput` (experimental API), answers keyed by question id | Offline |
| Interrupt | `turn/interrupt`; turn ends `interrupted` | Offline |
| Resume | `thread/resume`; the tool server is passed again at process start | Offline |
| Errors | `usageLimitExceeded`/`rateLimitExceeded` → `RATE_LIMITED`, `unauthorized` → `ACCOUNT_EXPIRED`, overload/connection → retryable `PROVIDER_ERROR` | Offline |

### Why not Codex dynamic tools

The experimental API also lets a client pass tools directly (`dynamicTools` on `thread/start`, answered through `item/tool/call`), which would remove the local HTTP server. `thread/resume` does not accept them in 0.164.0, so tools could disappear after crash recovery. MCP is what the Graph editor already runs live. Revisit if `thread/resume` gains the field.

## Differences from the Graph editor's adapters

- No copy of `~/.codex/auth.json`; each account signs in on its own.
- Codex's MCP configuration goes through `-c`, not a rewritten `config.toml`.
- Claude's default tools are reduced to the application's tools and `AskUserQuestion` (the Graph also offered Read, Glob, Grep, Bash, WebSearch, WebFetch, TodoWrite and skills). The plan's default policy keeps those out; an application can opt in with `builtInTools`, with the tool policy still enforced in `canUseTool`.
- Personal MCP servers and skills are not passed through.
- Sign-in runs the CLI's own login command instead of opening a terminal (Claude) or the app server's login flow (Codex). Whether that works without a terminal is the first live check.

## Platforms

| Platform | Status |
| --- | --- |
| macOS (Apple Silicon) | Offline suite; real CLIs signed out |
| macOS (Intel), Windows, Linux | Not run. Windows-specific code (PATHEXT, `.cmd` shims, `taskkill`, case-insensitive environment) exists but is untested |

## Open issues

- **Claude sign-in without a browser.** When the browser does not open, `claude auth login` prints an authorization URL whose flow ends in a code to paste into the terminal (`Paste code here if prompted >`). The adapter starts the command without a terminal, so that path cannot finish. The fix is a sign-in flow that hands the URL to the application and accepts the pasted code; it needs an extension of `connectAccount`.

## Live checks

Claude: done (2026-10-28). Codex: pending. For each provider, with two accounts (A, B) of different identities:

1. Sign in A and B through `edukors-ai connect`; confirm each opens the browser and finishes without a terminal.
2. Confirm `status` shows each account's own identity, and that the user's personal CLI sign-in is unchanged.
3. Open one session per account at the same time and confirm each answers as its own account.
4. Run a tool call, a question, an interruption, and a resume after killing the provider process.
5. Read usage limits and check their scale and windows.
6. Sign A out; confirm B is unaffected.
