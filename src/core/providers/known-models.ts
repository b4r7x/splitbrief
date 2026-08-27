import type { ProviderId } from '../schemas/enums.js';

export type ModelRecommendation = 'recommended' | 'compatible-only';

export interface KnownModel {
  name: string;
  recommendation: ModelRecommendation;
  isDefault?: boolean;
  contextLength?: number;
  maxOutputTokens?: number;
  pricingInput?: number;
  pricingOutput?: number;
  pricingCacheRead?: number;
  pricingCacheWrite?: number;
  isFree?: boolean;
  aliases?: string[];
  catalogProvider?: ProviderId;
  catalogModelId?: string;
  provenance?: string;
}

export const PENDING_EVALUATION_CANDIDATE_IDS = Object.freeze([
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'ollama', model: 'qwen3-coder:30b' },
  { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
] as const satisfies readonly { provider: ProviderId; model: string }[]);

// `recommended` is reserved for a model with recorded T-080 evaluation metrics.
// No credentialed evaluation run exists, so every bundled row is compatible-only.
function compatibleModel(model: Omit<KnownModel, 'recommendation'>): KnownModel {
  return { ...model, recommendation: 'compatible-only' };
}

export const DEFAULT_AGENT_SDK_MODEL = 'claude-sonnet-5';

// Cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-08-27.
// Sonnet 5: cache read = $0.20/MTok (0.1x base input), cache write = $2.50/MTok (1.25x, 5-minute TTL).
const CLAUDE_SONNET_5_PRICING = {
  pricingInput: 2,
  pricingOutput: 10,
  pricingCacheRead: 0.2,
  pricingCacheWrite: 2.5,
} as const;

// Opus 5: cache read = $0.50/MTok (0.1x base input), cache write = $6.25/MTok (1.25x, 5-minute TTL).
const CLAUDE_OPUS_5_PRICING = {
  pricingInput: 5,
  pricingOutput: 25,
  pricingCacheRead: 0.5,
  pricingCacheWrite: 6.25,
} as const;

export const KNOWN_MODELS: Partial<Record<ProviderId, KnownModel[]>> = {
  'claude-code': [
    compatibleModel({
      name: 'sonnet',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'opus',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'opusplan',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'haiku',
      contextLength: 200_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-haiku-4-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
  ],
  codex: [
    compatibleModel({
      name: 'gpt-5.6-sol',
      contextLength: 272_000,
      catalogProvider: 'openai',
      provenance: 'Codex native probe cliCatalogs (2026-08)',
    }),
    compatibleModel({
      name: 'gpt-5.5',
      contextLength: 272_000,
      catalogProvider: 'openai',
      provenance: 'Codex native probe cliCatalogs (2026-08)',
    }),
    compatibleModel({
      name: 'gpt-5.4',
      contextLength: 272_000,
      catalogProvider: 'openai',
      provenance: 'Codex native probe cliCatalogs (2026-08)',
    }),
  ],
  aider: [
    compatibleModel({
      name: 'claude-sonnet-5',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Minimal bundled fallback (2026-08)',
    }),
    compatibleModel({
      name: 'gpt-5.6-sol',
      contextLength: 272_000,
      catalogProvider: 'openai',
      provenance: 'Minimal bundled fallback (2026-08)',
    }),
  ],
  opencode: [
    compatibleModel({
      name: 'anthropic/claude-sonnet-5',
      contextLength: 1_000_000,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-08)',
    }),
    compatibleModel({
      name: 'openai/gpt-5.6-sol',
      contextLength: 272_000,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-08)',
    }),
  ],
  copilot: [
    compatibleModel({
      name: 'claude-opus-5',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: 'Minimal bundled fallback (2026-08)',
    }),
    compatibleModel({
      name: 'gpt-5.6-sol',
      contextLength: 272_000,
      catalogProvider: 'openai',
      provenance: 'Minimal bundled fallback (2026-08)',
    }),
  ],
  'agent-sdk': [
    compatibleModel({
      name: DEFAULT_AGENT_SDK_MODEL,
      isDefault: true,
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 5 fallback (2026-08); unpriced-meta, pricing not served',
    }),
    compatibleModel({
      name: 'claude-opus-5',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 5 fallback (2026-08); unpriced-meta, pricing not served',
    }),
  ],
  anthropic: [
    compatibleModel({
      name: 'claude-sonnet-5',
      isDefault: true,
      contextLength: 1_000_000,
      ...CLAUDE_SONNET_5_PRICING,
      provenance:
        'Anthropic Claude 5 fallback (2026-08); cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-08-27',
    }),
    compatibleModel({
      name: 'claude-opus-5',
      contextLength: 1_000_000,
      ...CLAUDE_OPUS_5_PRICING,
      provenance:
        'Anthropic Claude 5 fallback (2026-08); cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-08-27',
    }),
  ],
  openrouter: [
    compatibleModel({
      name: 'anthropic/claude-sonnet-5',
      isDefault: true,
      catalogProvider: 'openrouter',
      provenance:
        'Minimal bundled fallback (2026-08); T-080 evaluation candidate, OMIT-NOT-APPLICABLE until a credentialed run records metrics',
    }),
    compatibleModel({
      name: 'openrouter/free',
      isFree: true,
      provenance:
        'OpenRouter free pool; opportunistic fallback, not a reproducible default (2026-07)',
    }),
  ],
  ollama: [
    compatibleModel({
      name: 'qwen3-coder:30b',
      isDefault: true,
      provenance:
        'Ollama local model fallback; context limit discovered from the daemon (2026-07); T-080 evaluation candidate',
    }),
  ],
  'ollama-cloud': [
    compatibleModel({
      name: 'kimi-k2.7-code',
      isDefault: true,
      provenance:
        'Ollama Cloud direct /api/tags fallback (2026-08-01); live account inventory is authoritative',
    }),
  ],
  'lm-studio': [
    compatibleModel({
      name: 'qwen2.5-coder-7b',
      isDefault: true,
      provenance:
        'LM Studio local model fallback; context limit discovered from the daemon (2026-07); T-080 evaluation candidate',
    }),
  ],
  deepseek: [
    compatibleModel({
      name: 'deepseek-v4-flash',
      isDefault: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      pricingInput: 0.14,
      pricingOutput: 0.28,
      provenance: 'DeepSeek V4 Flash fallback (2026-07); 1M context and 384K maximum output',
    }),
    compatibleModel({
      name: 'deepseek-v4-pro',
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      pricingInput: 0.435,
      pricingOutput: 0.87,
      provenance: 'DeepSeek V4 Pro fallback (2026-07); 1M context and 384K maximum output',
    }),
  ],
  openai: [
    compatibleModel({
      name: 'gpt-5.6-sol',
      isDefault: true,
      contextLength: 272_000,
      pricingInput: 4,
      pricingOutput: 20,
      provenance:
        'OpenAI flagship fallback (2026-08); standard short-context rate from platform.openai.com/docs/pricing, long-context tiers not applied',
    }),
    compatibleModel({
      name: 'gpt-5.5',
      contextLength: 272_000,
      provenance: 'OpenAI coding fallback (2026-08)',
    }),
  ],
  groq: [
    compatibleModel({
      name: 'openai/gpt-oss-120b',
      isDefault: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      provenance:
        'Groq GPT OSS 120B default; max_completion_tokens contract (2026-07); T-080 evaluation candidate, OMIT-NOT-APPLICABLE until a credentialed run records metrics',
    }),
  ],
  together: [
    compatibleModel({
      name: 'zai-org/GLM-5.1',
      isDefault: true,
      provenance: 'Together Coding Agents model (2026-08)',
    }),
  ],
};
