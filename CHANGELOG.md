# Changelog

## 0.1.0 (unreleased)

- Provider adapter contract, normalized events and stable error codes.
- Shared, versioned account registry with atomic writes and cross-process locking.
- Session lifecycle: tool routing with validation, questions, interruption with grace period, late-event dropping, crash recovery with resume.
- CLI discovery, allowlisted process environment, process-tree termination, bounded output, redacted diagnostics.
- stdio application-host protocol (`edukors-ai-host`) and terminal tool (`edukors-ai`).
- Fake provider CLI and adapter for deterministic tests.
