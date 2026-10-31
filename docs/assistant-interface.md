# Shared assistant interface

The Graph and Slides editors now consume `@edukors/ai-ui` from `packages/ui`,
separately from the Node-based `@edukors/ai-cli` runtime. UI components accept
serializable data and host callbacks, inherit EDUKORS CSS variables and provide
Portuguese, English and Spanish labels. React 19 is supplied by the host.

## Published versions

Current integration: `@edukors/ai-cli` 0.2.2 and `@edukors/ai-ui` 0.1.4, both on npm.
Both editors pin these exact versions and commit their lockfiles. The Graph agent
staging script carries the runtime; renderer UI stays in its web bundle. Never point
a desktop build at a sibling repository's unbuilt source.

While changing the UI locally, build the runtime (`npm run build`), run `npm pack
--ignore-scripts` for the runtime and the UI package and install the tarballs in the
editors; before a release, publish and pin the registry versions instead. Bump the
package version for every change: npm caches tarballs by source URL. Never republish
a version with different contents. Desktop releases remain separate steps.

## Host contracts

- `AssistantAccounts` handles cards, service selection and the sign-in display.
  Host callbacks own detection, authentication, removal and persistence. Missing
  providers remain selectable for instructions. A refresh must bypass detection
  caches. Unsupported provider/platform combinations are distinct from missing CLIs.
- `AccountPicker` is used in configuration. Accounts are changed only there;
  neither composer includes an account selector. Changing configuration starts a
  conversation on the chosen account and preserves the earlier conversation.
- `ProviderSetup` displays commands and official links. It never downloads or runs
  an installer. Metadata and command templates come from the browser-safe runtime
  settings export (`PROVIDER_CATALOG`, `installationCommand`).
- `ModelOptions` uses an upward-opening model list and a discrete effort slider.
  `ModePicker` uses the original compact chips, icons and upward-opening menu.
  Both support Escape, outside click and keyboard navigation. Model options offer
  only efforts reported by the selected model; unknown
  combinations use the provider default. Hosts own loading/retry and rollback of
  failed option updates.
- `UsageSummary` consumes normalized `windows` and `observedAt`. It never invents
  a zero, merges account usage with token context, or reads private provider files.
- `AssistantHeader`, `ConversationList`, `QuestionCard` and `ModePicker` share
  presentation. Document tools, approval enforcement, undo and validation stay in
  each editor. Graph keeps its richer multi-question cards and Markdown rendering.

## Scope and migration

Accounts remain in the same registry; account IDs are preserved. App defaults,
model preferences, instructions, MCP configuration and skills remain app-local.
Removing an account removes its managed data, leaves documents/transcripts and
never signs into an alternative account silently. Other apps refresh on focus and
before sending; no background account-management service was added.

New Graph conversations bind to a document, with path metadata for saved documents.
Earlier conversations without a reliable association remain readable; start a new
conversation to edit the current document. During an in-flight request, its document
remains bound even if the user changes tabs; the displayed conversation switches
after the request ends. A single Graph agent request runs at a time, as before.

Slides restores each conversation's account and supports review-before-apply or
validated direct application. Existing accounts keep their previous direct mode;
new installs default to review. Planning is not offered in Slides because its native
workspace tools are not constrained to read-only; Graph retains enforced planning.
Pending proposals remain in the editor and can be accepted or discarded. Approval
is for document changes; MCP calls keep their separate authorization.

## Validation

Consumers typecheck and build the package. Slides' normal test suite additionally
runs `scripts/test-ai-ui-contract.mjs`: per-model options, installation routes,
first-run availability, usage windows, conditional login code, translations and
escaping. Graph tests exercise account-default independence, document separation
and in-flight controls using the actual stdio host with a fake provider.

`scripts/e2e.mjs --ai-ui` in Slides runs browser interaction and viewport checks.
Full interactive validation requires a working Playwright browser or Chrome and
permission to launch it. Provider bridge tests also require binding 127.0.0.1;
a sandbox refusal is not a successful test or a product-level incompatibility.
