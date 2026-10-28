# Changelog

## 0.1.0 (unreleased)

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
- Usage reports every limit window (`windows`), the most used one as `limitUsed`.
