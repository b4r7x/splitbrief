// Re-export provider IDs and types from schemas layer (source of truth)
export {
  PROVIDER_IDS,
  PLANNER_TOOL_IDS,
  CLI_TOOL_IDS,
  API_PROVIDER_IDS,
  LOCAL_PROVIDER_IDS,
  META_PROVIDER_IDS,
  isProviderId,
  isPlannerToolId,
  type ProviderId,
  type PlannerToolId,
  type CliToolId,
  type ApiProviderId,
  type LocalProviderId,
  type MetaProviderId,
} from '../types/schemas/enums.js';

// Import for local use within this file
import { isProviderId, type ProviderId } from '../types/schemas/enums.js';

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  baseURL?: string;
  isLocal?: boolean;
  apiKeyEnv?: string;
}

// Source of truth for known provider base URLs. `PROVIDER_CATALOG` references
// these by name, so the catalog never owns a base URL the rest of the code
// would otherwise have to assert non-null.
export const KNOWN_PROVIDER_BASE_URLS = {
  ollama: 'http://localhost:11434/v1',
  'lm-studio': 'http://localhost:1234/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
} as const;

// Extended base URL map including API-only providers (e.g., anthropic).
// Used by resolveDefaultApiBase for symmetric runner config resolution.
export const KNOWN_API_BASE_URLS: Record<string, string> = {
  ...KNOWN_PROVIDER_BASE_URLS,
  anthropic: 'https://api.anthropic.com/v1',
};

export function resolveDefaultApiBase(providerId: string): string | null {
  return KNOWN_API_BASE_URLS[providerId] ?? null;
}

export const KNOWN_PROVIDER_NAMES = Object.keys(KNOWN_PROVIDER_BASE_URLS) as readonly (keyof typeof KNOWN_PROVIDER_BASE_URLS)[];

export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo> = {
  'claude-code': { id: 'claude-code', displayName: 'Claude Code' },
  codex: { id: 'codex', displayName: 'Codex' },
  opencode: { id: 'opencode', displayName: 'OpenCode' },
  aider: { id: 'aider', displayName: 'Aider' },
  copilot: { id: 'copilot', displayName: 'Copilot' },
  'kilo-code': { id: 'kilo-code', displayName: 'Kilo Code' },
  'agent-sdk': { id: 'agent-sdk', displayName: 'Agent SDK', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  // Anthropic's native API is NOT OpenAI-compatible (/v1/messages vs /v1/chat/completions).
  // Use claude-code (CLI), agent-sdk (SDK), or openrouter (API proxy) for Anthropic models.
  anthropic: { id: 'anthropic', displayName: 'Anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { id: 'openrouter', displayName: 'OpenRouter', baseURL: KNOWN_PROVIDER_BASE_URLS.openrouter, apiKeyEnv: 'OPENROUTER_API_KEY' },
  ollama: { id: 'ollama', displayName: 'Ollama', baseURL: KNOWN_PROVIDER_BASE_URLS.ollama, isLocal: true },
  'lm-studio': { id: 'lm-studio', displayName: 'LM Studio', baseURL: KNOWN_PROVIDER_BASE_URLS['lm-studio'], isLocal: true },
  deepseek: { id: 'deepseek', displayName: 'DeepSeek', baseURL: KNOWN_PROVIDER_BASE_URLS.deepseek, apiKeyEnv: 'DEEPSEEK_API_KEY' },
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
  return PROVIDER_CATALOG[id].isLocal === true;
}

export function getProviderApiKeyEnv(id: string): string | undefined {
  if (!isProviderId(id)) return undefined;
  return PROVIDER_CATALOG[id].apiKeyEnv;
}

export function hasApiKey(providerId: string): boolean {
  const envVar = getProviderApiKeyEnv(providerId);
  return envVar ? !!process.env[envVar] : false;
}
