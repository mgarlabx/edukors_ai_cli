import type { ProviderAdapter } from "./provider.js";
import { createClaudeProvider } from "./providers/claude/adapter.js";
import { createCodexProvider } from "./providers/codex/adapter.js";
import { createFakeProvider } from "./testing/fakeProvider.js";

/**
 * The adapters the bundled executables (`edukors-ai`, `edukors-ai-host`)
 * offer, in the order a provider menu shows them. `--fake` adds the
 * deterministic test provider.
 */
export function bundledProviders(options: { fake?: boolean } = {}): ProviderAdapter[] {
  const providers: ProviderAdapter[] = [createClaudeProvider(), createCodexProvider()];
  if (options.fake) providers.push(createFakeProvider());
  return providers;
}
