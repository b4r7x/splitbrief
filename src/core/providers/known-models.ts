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
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'ollama', model: 'qwen3-coder:30b' },
  { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
] as const satisfies readonly { provider: ProviderId; model: string }[]);

// `recommended` is reserved for a model with recorded T-080 evaluation metrics.
// No credentialed evaluation run exists, so every bundled row is compatible-only.
function compatibleModel(model: Omit<KnownModel, 'recommendation'>): KnownModel {
  return { ...model, recommendation: 'compatible-only' };
}

export const DEFAULT_AGENT_SDK_MODEL = 'claude-sonnet-4-6';

// Cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-04-26.
// Sonnet 4.6: cache read = $0.30/MTok (0.1x base input), cache write = $3.75/MTok (1.25x, 5-minute TTL).
const CLAUDE_SONNET_46_PRICING = {
  pricingInput: 3,
  pricingOutput: 15,
  pricingCacheRead: 0.3,
  pricingCacheWrite: 3.75,
} as const;

// Opus 4.6: cache read = $0.50/MTok (0.1x base input), cache write = $6.25/MTok (1.25x, 5-minute TTL).
const CLAUDE_OPUS_46_PRICING = {
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
      catalogModelId: 'claude-sonnet-4-6',
      provenance: 'Claude Code model aliases (2026-04)',
    }),
    compatibleModel({
      name: 'opus',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-4-6',
      provenance: 'Claude Code model aliases (2026-04)',
    }),
    compatibleModel({
      name: 'opusplan',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-4-6',
      provenance: 'Claude Code model aliases (2026-04)',
    }),
  ],
  codex: [
    compatibleModel({
      name: 'gpt-5.4',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'OpenAI flagship coding model (2026-04)',
    }),
    compatibleModel({
      name: 'gpt-5-codex',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'OpenAI coding-specialized model (2026-04)',
    }),
  ],
  aider: [
    compatibleModel({
      name: 'claude-sonnet-4-6',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Minimal bundled fallback (2026-04)',
    }),
    compatibleModel({
      name: 'gpt-5.4',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'Minimal bundled fallback (2026-04)',
    }),
  ],
  opencode: [
    compatibleModel({
      name: 'anthropic/claude-sonnet-4.6',
      contextLength: 1_000_000,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-04)',
    }),
    compatibleModel({
      name: 'openai/gpt-5.4',
      contextLength: 1_050_000,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-04)',
    }),
  ],
  copilot: [
    compatibleModel({
      name: 'claude-opus-4.6',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-4-6',
      provenance: 'Minimal bundled fallback (2026-04)',
    }),
    compatibleModel({
      name: 'gpt-5.2-codex',
      contextLength: 1_050_000,
      catalogProvider: 'openai',
      provenance: 'Minimal bundled fallback (2026-04)',
    }),
  ],
  'agent-sdk': [
    compatibleModel({
      name: DEFAULT_AGENT_SDK_MODEL,
      isDefault: true,
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 4.6 fallback (2026-04); unpriced-meta, pricing not served',
    }),
    compatibleModel({
      name: 'claude-opus-4-6',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 4.6 fallback (2026-04); unpriced-meta, pricing not served',
    }),
  ],
  anthropic: [
    compatibleModel({
      name: 'claude-sonnet-4-6',
      isDefault: true,
      contextLength: 1_000_000,
      ...CLAUDE_SONNET_46_PRICING,
      provenance:
        'Anthropic Claude 4.6 fallback (2026-04); cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-04-26',
    }),
    compatibleModel({
      name: 'claude-opus-4-6',
      contextLength: 1_000_000,
      ...CLAUDE_OPUS_46_PRICING,
      provenance:
        'Anthropic Claude 4.6 fallback (2026-04); cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-04-26',
    }),
  ],
  openrouter: [
    compatibleModel({
      name: 'anthropic/claude-sonnet-4.6',
      isDefault: true,
      catalogProvider: 'openrouter',
      provenance:
        'Minimal bundled fallback (2026-04); T-080 evaluation candidate, OMIT-NOT-APPLICABLE until a credentialed run records metrics',
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
      name: 'gpt-5.4',
      isDefault: true,
      contextLength: 1_050_000,
      pricingInput: 2.5,
      pricingOutput: 15,
      provenance:
        'OpenAI flagship fallback (2026-04); flat base rate, models.dev context_over_200k tiers not applied',
    }),
    compatibleModel({
      name: 'gpt-5-codex',
      contextLength: 1_050_000,
      provenance: 'OpenAI coding-specialized fallback (2026-04)',
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
      provenance: 'Together recommended Coding Agents model (2026-04)',
    }),
  ],
};
