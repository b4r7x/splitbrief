import { isProviderId, type ProviderId } from '../types/schemas/enums.js';

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
} as const;

const KNOWN_API_BASE_URLS: Record<string, string> = {
  ...KNOWN_PROVIDER_BASE_URLS,
  anthropic: 'https://api.anthropic.com/v1',
};

export function resolveDefaultApiBase(providerId: string): string | null {
  return KNOWN_API_BASE_URLS[providerId] ?? null;
}

export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo> = {
  'claude-code': { id: 'claude-code', displayName: 'Claude Code' },
  codex: { id: 'codex', displayName: 'Codex' },
  opencode: { id: 'opencode', displayName: 'OpenCode' },
  aider: { id: 'aider', displayName: 'Aider' },
  copilot: { id: 'copilot', displayName: 'Copilot', isSubscription: true },
  'kilo-code': { id: 'kilo-code', displayName: 'Kilo Code', isSubscription: true },
  'agent-sdk': { id: 'agent-sdk', displayName: 'Agent SDK', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  anthropic: { id: 'anthropic', displayName: 'Anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { id: 'openrouter', displayName: 'OpenRouter', baseURL: KNOWN_PROVIDER_BASE_URLS.openrouter, apiKeyEnv: 'OPENROUTER_API_KEY' },
  deepseek: { id: 'deepseek', displayName: 'DeepSeek', baseURL: KNOWN_PROVIDER_BASE_URLS.deepseek, apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { id: 'openai', displayName: 'OpenAI', baseURL: KNOWN_PROVIDER_BASE_URLS.openai, apiKeyEnv: 'OPENAI_API_KEY' },
  groq: { id: 'groq', displayName: 'Groq', baseURL: KNOWN_PROVIDER_BASE_URLS.groq, apiKeyEnv: 'GROQ_API_KEY' },
  together: { id: 'together', displayName: 'Together AI', baseURL: KNOWN_PROVIDER_BASE_URLS.together, apiKeyEnv: 'TOGETHER_API_KEY' },
  ollama: { id: 'ollama', displayName: 'Ollama', baseURL: KNOWN_PROVIDER_BASE_URLS.ollama, isLocal: true },
  'lm-studio': { id: 'lm-studio', displayName: 'LM Studio', baseURL: KNOWN_PROVIDER_BASE_URLS['lm-studio'], isLocal: true },
  shell: { id: 'shell', displayName: 'Custom Shell' },
  agent: { id: 'agent', displayName: 'Agent' },
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
