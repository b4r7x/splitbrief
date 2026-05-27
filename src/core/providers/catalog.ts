import { isProviderId, type ProviderId } from '../schemas/enums.js';

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  baseURL?: string;
  isLocal?: boolean;
  isSubscription?: boolean;
  apiKeyEnv?: string;
}

export const KNOWN_PROVIDER_BASE_URLS = {
  ollama: 'http://localhost:11434/v1',
  'lm-studio': 'http://localhost:1234/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  anthropic: 'https://api.anthropic.com/v1',
} as const;

export function resolveDefaultApiBase(providerId: string): string | null {
  const urls: Record<string, string> = KNOWN_PROVIDER_BASE_URLS;
  return urls[providerId] ?? null;
}

type ProviderIdWithBaseURL = keyof typeof KNOWN_PROVIDER_BASE_URLS;

function hasKnownBaseURL(id: ProviderId): id is ProviderId & ProviderIdWithBaseURL {
  return id in KNOWN_PROVIDER_BASE_URLS;
}

function makeProvider(
  id: ProviderId,
  displayName: string,
  extras: Omit<ProviderInfo, 'id' | 'displayName' | 'baseURL'> = {},
): ProviderInfo {
  return {
    id,
    displayName,
    ...(hasKnownBaseURL(id) && { baseURL: KNOWN_PROVIDER_BASE_URLS[id] }),
    ...extras,
  };
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo> = {
  'claude-code': makeProvider('claude-code', 'Claude Code'),
  codex: makeProvider('codex', 'Codex'),
  opencode: makeProvider('opencode', 'OpenCode'),
  aider: makeProvider('aider', 'Aider'),
  copilot: makeProvider('copilot', 'Copilot', { isSubscription: true }),
  'kilo-code': makeProvider('kilo-code', 'Kilo Code', { isSubscription: true }),
  'agent-sdk': makeProvider('agent-sdk', 'Agent SDK', { apiKeyEnv: 'ANTHROPIC_API_KEY' }),
  anthropic: makeProvider('anthropic', 'Anthropic', { apiKeyEnv: 'ANTHROPIC_API_KEY' }),
  openrouter: makeProvider('openrouter', 'OpenRouter', { apiKeyEnv: 'OPENROUTER_API_KEY' }),
  deepseek: makeProvider('deepseek', 'DeepSeek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }),
  openai: makeProvider('openai', 'OpenAI', { apiKeyEnv: 'OPENAI_API_KEY' }),
  groq: makeProvider('groq', 'Groq', { apiKeyEnv: 'GROQ_API_KEY' }),
  together: makeProvider('together', 'Together AI', { apiKeyEnv: 'TOGETHER_API_KEY' }),
  ollama: makeProvider('ollama', 'Ollama', { isLocal: true, apiKeyEnv: 'OLLAMA_API_KEY' }),
  'lm-studio': makeProvider('lm-studio', 'LM Studio', { isLocal: true }),
  shell: makeProvider('shell', 'Custom Shell'),
  agent: makeProvider('agent', 'Agent'),
};

export function getProviderDisplayName(id: string): string {
  if (!isProviderId(id)) return id;
  return PROVIDER_CATALOG[id].displayName;
}

export function getProviderBaseURL(id: string): string {
  if (!isProviderId(id)) return '';
  return PROVIDER_CATALOG[id].baseURL ?? '';
}

export function isProviderLocal(id: string): boolean {
  if (!isProviderId(id)) return false;
  return Boolean(PROVIDER_CATALOG[id].isLocal);
}

export function isProviderSubscription(id: string): boolean {
  if (!isProviderId(id)) return false;
  return Boolean(PROVIDER_CATALOG[id].isSubscription);
}

function getProviderApiKeyEnv(id: string): string | undefined {
  if (!isProviderId(id)) return undefined;
  return PROVIDER_CATALOG[id].apiKeyEnv;
}

export function hasApiKey(providerId: string): boolean {
  const envVar = getProviderApiKeyEnv(providerId);
  return Boolean(envVar && process.env[envVar]);
}
