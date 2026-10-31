# EDUKORS AI UI

Host-independent React 19 components shared by the Graph and Slides editors.
Import components from `@edukors/ai-ui` and styles from `@edukors/ai-ui/style.css`.
No Node, Electron, Tauri or provider runtime is imported. Hosts supply serializable
state and callbacks; provider authentication and document validation stay in their
existing layers. Installation commands are text only and never executed here.

PT/EN/ES strings, account setup, model/effort selection, usage windows, history,
questions and panel headers share the same implementation. The package uses native
form controls and inherits EDUKORS CSS variables and the host theme.

Published on npm as `@edukors/ai-ui`; the editors pin an exact version. It needs
`@edukors/ai-cli` 0.2.2 or later (for `PROVIDER_CATALOG` and `installationCommand`).
