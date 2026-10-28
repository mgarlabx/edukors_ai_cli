# Contributing

- All code, identifiers, comments and documentation are in English.
- `npm run typecheck && npm test` must pass. The normal suite never needs a real provider account.
- New provider behavior comes with a fake-provider scenario (`fixtures/fake-ai.mjs`) or an adapter-level fixture, plus a test.
- Live smoke tests against real accounts run locally only. Never commit credentials, account directories or registry files.
- Adapters advertise only capabilities that have been verified. If a provider cannot do something reliably, report it as unsupported.
- Keep the core independent of Electron, Tauri, React and application document schemas.
