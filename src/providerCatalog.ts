/** Public installation metadata, safe for renderers: no provider or Node imports. */
export const PROVIDER_CATALOG = [
  { id: 'claude', name: 'Claude — Anthropic', cli: 'Claude Code (CLI)', url: 'https://code.claude.com/docs/en/quickstart' },
  { id: 'codex', name: 'Codex — OpenAI', cli: 'Codex CLI', url: 'https://learn.chatgpt.com/docs/codex/cli' },
] as const;
export function installationCommand(provider: string, platform: string): string {
  if (!PROVIDER_CATALOG.some(p => p.id === provider)) throw new Error('Unknown provider');
  const host = provider === 'claude' ? 'claude.ai' : 'chatgpt.com/codex';
  return platform === 'windows' ? `irm https://${host}/install.ps1 | iex` : `curl -fsSL https://${host}/install.sh | ${provider === 'claude' ? 'bash' : 'sh'}`;
}
