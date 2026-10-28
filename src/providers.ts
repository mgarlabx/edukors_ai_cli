import type { ProviderAdapter } from "./provider.js";
import { createFakeProvider } from "./testing/fakeProvider.js";

/**
 * The adapters the bundled executables (`edukors-ai`, `edukors-ai-host`)
 * offer. Real providers (Claude, Codex, ...) are added here as they are
 * ported; until then, `--fake` enables the deterministic fake provider.
 */
export function bundledProviders(options: { fake?: boolean } = {}): ProviderAdapter[] {
  const providers: ProviderAdapter[] = [];
  if (options.fake) providers.push(createFakeProvider());
  return providers;
}
