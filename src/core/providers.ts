import { isProviderId, type ProviderId } from './types/schemas/enums.js';

export { formatModelName, stripVendorPrefix } from './model-display.js';

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
} from './types/schemas/enums.js';

interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  baseURL?: string;
  isLocal?: boolean;
  isSubscription?: boolean;
  apiKeyEnv?: string;
}

export interface KnownModel {
  name: string;
  isDefault?: boolean;
  contextLength?: number;
  pricingInput?: number;
  pricingOutput?: number;
  isFree?: boolean;
  aliases?: string[];
  catalogProvider?: ProviderId;
  catalogModelId?: string;
  provenance?: string;
}

export const KNOWN_MODELS: Partial<Record<ProviderId, KnownModel[]>> = {
  'claude-code': [
    { name: 'default', isDefault: true, aliases: ['auto'], provenance: 'Claude Code model aliases (2026-04)' },
    {
      name: 'sonnet',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-4-6',
      provenance: 'Claude Code model aliases (2026-04)',
    },
    {
      name: 'opus',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-4-6',
      provenance: 'Claude Code model aliases (2026-04)',
    },
    {
      name: 'opusplan',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-4-6',
      provenance: 'Claude Code model aliases (2026-04)',
    },
  ],
  codex: [
    { name: 'auto', isDefault: true },
    {
      name: 'gpt-5.4',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'OpenAI flagship coding model (2026-04)',
    },
    {
      name: 'gpt-5-codex',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'OpenAI coding-specialized model (2026-04)',
    },
  ],
  aider: [
    { name: 'auto', isDefault: true },
    {
      name: 'claude-sonnet-4-6',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
    {
      name: 'gpt-5.4',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
  ],
  opencode: [
    { name: 'auto', isDefault: true },
    {
      name: 'anthropic/claude-sonnet-4.6',
      contextLength: 1_000_000,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
    {
      name: 'openai/gpt-5.4',
      contextLength: 1_050_000,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
  ],
  copilot: [
    { name: 'auto', isDefault: true },
    {
      name: 'claude-opus-4.6',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-4-6',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
    {
      name: 'gpt-5.2-codex',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
  ],
  'kilo-code': [
    { name: 'auto', isDefault: true },
  ],
  'agent-sdk': [
    {
      name: 'claude-sonnet-4-6',
      isDefault: true,
      contextLength: 1_000_000,
      pricingInput: 3,
      pricingOutput: 15,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 4.6 fallback (2026-04)',
    },
    {
      name: 'claude-opus-4-6',
      contextLength: 1_000_000,
      pricingInput: 5,
      pricingOutput: 25,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 4.6 fallback (2026-04)',
    },
  ],
  anthropic: [
    {
      name: 'claude-sonnet-4-6',
      isDefault: true,
      contextLength: 1_000_000,
      pricingInput: 3,
      pricingOutput: 15,
      provenance: 'Anthropic Claude 4.6 fallback (2026-04)',
    },
    {
      name: 'claude-opus-4-6',
      contextLength: 1_000_000,
      pricingInput: 5,
      pricingOutput: 25,
      provenance: 'Anthropic Claude 4.6 fallback (2026-04)',
    },
  ],
  openrouter: [
    {
      name: 'anthropic/claude-sonnet-4.6',
      isDefault: true,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
  ],
  ollama:     [{ name: 'qwen2.5-coder:7b', isDefault: true }],
  'lm-studio': [{ name: 'qwen2.5-coder-7b', isDefault: true }],
  deepseek: [
    {
      name: 'deepseek-chat',
      isDefault: true,
      contextLength: 128_000,
      pricingInput: 0.28,
      pricingOutput: 0.42,
      provenance: 'DeepSeek V3.2 fallback (2026-04)',
    },
    {
      name: 'deepseek-reasoner',
      contextLength: 128_000,
      provenance: 'DeepSeek V3.2 fallback (2026-04)',
    },
  ],
  openai: [
    {
      name: 'auto',
      isDefault: true,
      catalogProvider: 'openai',
      catalogModelId: 'gpt-5.4',
      provenance: 'OpenAI auto fallback -> bundled default (2026-04)',
    },
    {
      name: 'gpt-5.4',
      contextLength: 1_050_000,
      pricingInput: 2.5,
      pricingOutput: 15,
      provenance: 'OpenAI flagship fallback (2026-04)',
    },
    {
      name: 'gpt-5-codex',
      contextLength: 1_050_000,
      provenance: 'OpenAI coding-specialized fallback (2026-04)',
    },
  ],
  groq:     [],
  together: [
    {
      name: 'zai-org/GLM-5.1',
      isDefault: true,
      provenance: 'Together recommended Coding Agents model (2026-04)',
    },
  ],
};

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

function getDefaultResolvedModel(providerId: ProviderId): string | undefined {
  const defaultModel = (KNOWN_MODELS[providerId] ?? []).find((entry) => entry.isDefault);
  if (!defaultModel) return undefined;
  if (defaultModel.catalogModelId) return defaultModel.catalogModelId;
  if (defaultModel.name === 'auto' || defaultModel.name === 'default') return undefined;
  return defaultModel.name;
}

export function normalizeConfiguredModel(model: string | undefined, providerId?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (trimmed === '') return undefined;
  if (providerId === 'claude-code' && trimmed.toLowerCase() === 'auto') return 'default';
  return trimmed;
}

export function resolveAutoModel(model: string | undefined, providerId?: string): string | undefined {
  const normalized = normalizeConfiguredModel(model, providerId);
  if (!normalized) return undefined;

  if (providerId === 'claude-code' && normalized.toLowerCase() === 'default') {
    return undefined;
  }

  if (normalized.toLowerCase() !== 'auto') return normalized;
  return providerId && isProviderId(providerId)
    ? getDefaultResolvedModel(providerId)
    : undefined;
}

