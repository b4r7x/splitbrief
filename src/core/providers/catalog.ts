export const PROVIDER_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'aider',
  'agent-sdk',
  'anthropic',
  'openrouter',
  'ollama',
  'lm-studio',
  'deepseek',
  'shell',
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];

interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  baseUrl?: string;
  isLocal?: boolean;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo> = {
  'claude-code': { id: 'claude-code', displayName: 'Claude Code' },
  codex: { id: 'codex', displayName: 'Codex' },
  opencode: { id: 'opencode', displayName: 'OpenCode' },
  aider: { id: 'aider', displayName: 'Aider' },
  'agent-sdk': { id: 'agent-sdk', displayName: 'Agent SDK' },
  anthropic: { id: 'anthropic', displayName: 'Anthropic' },
  openrouter: { id: 'openrouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  ollama: { id: 'ollama', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1', isLocal: true },
  'lm-studio': { id: 'lm-studio', displayName: 'LM Studio', baseUrl: 'http://localhost:1234/v1', isLocal: true },
  deepseek: { id: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  shell: { id: 'shell', displayName: 'Custom Shell' },
};

type KnownProviderName = 'ollama' | 'lm-studio' | 'deepseek' | 'openrouter';

export const KNOWN_PROVIDER_NAMES: readonly string[] = ['ollama', 'lm-studio', 'deepseek', 'openrouter'];

export const KNOWN_PROVIDER_BASE_URLS: Record<KnownProviderName, string> = {
  ollama: PROVIDER_CATALOG.ollama.baseUrl!,
  'lm-studio': PROVIDER_CATALOG['lm-studio'].baseUrl!,
  deepseek: PROVIDER_CATALOG.deepseek.baseUrl!,
  openrouter: PROVIDER_CATALOG.openrouter.baseUrl!,
};

export function getProviderDisplayName(id: string): string {
  return PROVIDER_CATALOG[id as ProviderId]?.displayName ?? id;
}

export function getProviderBaseUrl(id: string): string {
  return PROVIDER_CATALOG[id as ProviderId]?.baseUrl ?? '';
}

export function isProviderLocal(id: string): boolean {
  return PROVIDER_CATALOG[id as ProviderId]?.isLocal === true;
}
