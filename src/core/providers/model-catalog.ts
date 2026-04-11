import type { ProviderId } from './catalog.js';

export interface KnownModel {
  name: string;
  isDefault?: boolean;
  contextLength?: number; // e.g., 128000, 1048576
  pricingInput?: number; // USD per 1M tokens
  pricingOutput?: number; // USD per 1M tokens
  isFree?: boolean;
}

export const DEFAULT_AGENT_SDK_MODEL = 'claude-sonnet-4-6';

export function resolveAutoModel(model: string | undefined): string | undefined {
  if (!model || model.trim() === '' || model.toLowerCase() === 'auto') return undefined;
  return model;
}

const ANTHROPIC_MODELS: KnownModel[] = [
  { name: 'claude-sonnet-4-6', isDefault: true },
  { name: 'claude-opus-4-6' },
  { name: 'claude-opus-4-5' },
  { name: 'claude-sonnet-4-5' },
  { name: 'claude-sonnet-4' },
  { name: 'claude-haiku-4-5' },
];

const OPENROUTER_MODELS: KnownModel[] = [
  { name: 'anthropic/claude-sonnet-4.6', isDefault: true },
  { name: 'anthropic/claude-opus-4.6' },
  { name: 'anthropic/claude-opus-4.5' },
  { name: 'anthropic/claude-sonnet-4.5' },
  { name: 'anthropic/claude-haiku-4.5' },
  { name: 'openai/gpt-5.4' },
  { name: 'openai/gpt-5.4-mini' },
  { name: 'openai/gpt-5.2' },
  { name: 'openai/o4-mini' },
  { name: 'google/gemini-3.1-pro-preview' },
  { name: 'google/gemini-3-pro' },
  { name: 'deepseek/deepseek-v3.2' },
  { name: 'deepseek/deepseek-r1-0528' },
  { name: 'meta-llama/llama-4-scout' },
  { name: 'mistralai/mistral-large-latest' },
];

const OLLAMA_MODELS: KnownModel[] = [
  { name: 'qwen2.5-coder:7b', isDefault: true },
  { name: 'qwen2.5-coder:14b' },
  { name: 'qwen2.5-coder:32b' },
  { name: 'llama3.3:latest' },
  { name: 'deepseek-coder-v2:16b' },
  { name: 'codellama:13b' },
];

const LM_STUDIO_MODELS: KnownModel[] = [
  { name: 'qwen2.5-coder-7b', isDefault: true },
  { name: 'qwen2.5-coder-14b' },
  { name: 'qwen2.5-coder-32b' },
  { name: 'llama3.3' },
  { name: 'deepseek-coder-v2-16b' },
  { name: 'codellama-13b' },
];

const DEEPSEEK_MODELS: KnownModel[] = [
  { name: 'deepseek-chat', isDefault: true },
  { name: 'deepseek-coder' },
  { name: 'deepseek-reasoner' },
];

const COPILOT_MODELS: KnownModel[] = [
  { name: 'auto', isDefault: true },
  { name: 'gpt-5.4', contextLength: 1050000 },
  { name: 'gpt-5.4-mini', contextLength: 400000 },
  { name: 'gpt-5.3-codex', contextLength: 400000 },
  { name: 'gpt-5.2', contextLength: 400000 },
  { name: 'gpt-5.2-codex', contextLength: 400000 },
  { name: 'claude-sonnet-4-6', contextLength: 1000000 },
  { name: 'claude-opus-4-6', contextLength: 1000000 },
  { name: 'claude-opus-4-5', contextLength: 200000 },
  { name: 'claude-sonnet-4-5', contextLength: 200000 },
  { name: 'claude-haiku-4-5', contextLength: 200000 },
  { name: 'gemini-3-pro', contextLength: 1000000 },
  { name: 'gemini-3-flash', contextLength: 1048576 },
  { name: 'gemini-2.5-pro', contextLength: 1000000 },
  { name: 'o3-mini', contextLength: 200000 },
  { name: 'o4-mini', contextLength: 200000 },
  { name: 'grok-code-fast-1', contextLength: 131000 },
];

const KILO_CODE_MODELS: KnownModel[] = [
  { name: 'auto', isDefault: true },
  { name: 'claude-sonnet-4-6', contextLength: 1000000 },
  { name: 'claude-opus-4-6', contextLength: 1000000 },
  { name: 'claude-opus-4-5', contextLength: 200000 },
  { name: 'claude-sonnet-4-5', contextLength: 200000 },
  { name: 'claude-haiku-4-5', contextLength: 200000 },
  { name: 'gpt-5.4', contextLength: 1050000 },
  { name: 'gpt-5.4-mini', contextLength: 400000 },
  { name: 'gpt-5.3-codex', contextLength: 400000 },
  { name: 'o3-mini', contextLength: 200000 },
  { name: 'o4-mini', contextLength: 200000 },
  { name: 'gemini-3.1-pro', contextLength: 1000000 },
  { name: 'gemini-2.5-flash', contextLength: 1000000 },
  { name: 'grok-4', contextLength: 131000 },
  { name: 'deepseek-v3.2', contextLength: 128000 },
  { name: 'deepseek-r1', contextLength: 128000 },
  { name: 'kimi-k2.5', contextLength: 128000 },
  { name: 'nemotron-3-super-120b', contextLength: 262000, isFree: true },
];

const OPENCODE_MODELS: KnownModel[] = [
  { name: 'auto', isDefault: true },
  { name: 'anthropic/claude-sonnet-4-6', contextLength: 1000000 },
  { name: 'anthropic/claude-opus-4-6', contextLength: 1000000 },
  { name: 'anthropic/claude-opus-4-5', contextLength: 200000 },
  { name: 'anthropic/claude-sonnet-4-5', contextLength: 200000 },
  { name: 'anthropic/claude-haiku-4-5', contextLength: 200000 },
  { name: 'openai/gpt-5.4', contextLength: 1050000 },
  { name: 'openai/gpt-5.4-mini', contextLength: 400000 },
  { name: 'openai/gpt-5.3-codex', contextLength: 400000 },
  { name: 'openai/gpt-5.2', contextLength: 400000 },
  { name: 'openai/o4-mini', contextLength: 200000 },
  { name: 'openai/o3-mini', contextLength: 200000 },
  { name: 'google/gemini-3.1-pro-preview', contextLength: 1000000 },
  { name: 'google/gemini-3-pro', contextLength: 1000000 },
  { name: 'google/gemini-2.5-pro', contextLength: 1000000 },
  { name: 'deepseek/deepseek-v3.2', contextLength: 128000 },
  { name: 'deepseek/deepseek-r1', contextLength: 128000 },
  { name: 'groq/llama-3.3-70b', contextLength: 131000 },
  { name: 'xai/grok-4', contextLength: 131000 },
  { name: 'minimax/m2.1', contextLength: 197000 },
];

const AIDER_MODELS: KnownModel[] = [
  { name: 'auto', isDefault: true },
  { name: 'claude-sonnet-4-6', contextLength: 1000000 },
  { name: 'claude-opus-4-6', contextLength: 1000000 },
  { name: 'claude-opus-4-5', contextLength: 200000 },
  { name: 'claude-sonnet-4-5', contextLength: 200000 },
  { name: 'claude-haiku-4-5', contextLength: 200000 },
  { name: 'gpt-5.4', contextLength: 1050000 },
  { name: 'gpt-5.4-mini', contextLength: 400000 },
  { name: 'gpt-5.3-codex', contextLength: 400000 },
  { name: 'gpt-5.2', contextLength: 400000 },
  { name: 'o4-mini', contextLength: 200000 },
  { name: 'o3-mini', contextLength: 200000 },
  { name: 'gemini-3-pro', contextLength: 1000000 },
  { name: 'gemini-2.5-pro', contextLength: 1000000 },
  { name: 'deepseek/deepseek-v3.2', contextLength: 128000 },
  { name: 'deepseek/deepseek-r1', contextLength: 128000 },
  { name: 'grok-4', contextLength: 131000 },
];

const CODEX_MODELS: KnownModel[] = [
  { name: 'auto', isDefault: true },
  { name: 'gpt-5.4', contextLength: 1000000, pricingInput: 2.5, pricingOutput: 15 },
  { name: 'gpt-5.4-mini', contextLength: 400000, pricingInput: 0.75, pricingOutput: 4.5 },
  { name: 'gpt-5.4-nano', contextLength: 400000, pricingInput: 0.2, pricingOutput: 1.25 },
  { name: 'gpt-5.3-codex', contextLength: 400000 },
  { name: 'gpt-5.3-codex-spark', contextLength: 400000 },
  { name: 'gpt-5.2-codex', contextLength: 400000 },
  { name: 'gpt-5.2', contextLength: 400000 },
  { name: 'gpt-5.1-codex-max', contextLength: 256000 },
  { name: 'gpt-5.1-codex', contextLength: 256000 },
  { name: 'gpt-5.1', contextLength: 256000 },
  { name: 'o3', contextLength: 200000, pricingInput: 2, pricingOutput: 8 },
  { name: 'o3-mini', contextLength: 200000 },
  { name: 'o4-mini', contextLength: 200000, pricingInput: 1.1, pricingOutput: 4.4 },
  { name: 'codex-mini-latest', contextLength: 128000 },
];

export const KNOWN_MODELS: Partial<Record<ProviderId, KnownModel[]>> = {
  'claude-code': [
    { name: 'auto', isDefault: true },
    ...ANTHROPIC_MODELS.map(m => (m.isDefault ? { name: m.name } : m)),
  ],
  codex: CODEX_MODELS,
  aider: AIDER_MODELS,
  opencode: OPENCODE_MODELS,
  copilot: COPILOT_MODELS,
  'kilo-code': KILO_CODE_MODELS,
  'agent-sdk': ANTHROPIC_MODELS,
  anthropic: ANTHROPIC_MODELS,
  openrouter: OPENROUTER_MODELS,
  ollama: [...OLLAMA_MODELS, { name: 'starcoder2:7b' }],
  'lm-studio': LM_STUDIO_MODELS,
  deepseek: DEEPSEEK_MODELS,
};

export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'auto': 'Auto (tool default)',
  'deepseek-chat': 'DeepSeek V3',
  'deepseek-reasoner': 'DeepSeek R1',
  'deepseek-r1-0528': 'DeepSeek R1',
  'starcoder2:7b': 'StarCoder2 7B',
};
