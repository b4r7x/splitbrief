import type { ProviderId } from '../schemas/enums.js';

export interface KnownModel {
  name: string;
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
    { name: 'auto', isDefault: true, provenance: 'Claude Code model aliases (2026-04)' },
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
  'kilo-code': [{ name: 'auto', isDefault: true }],
  'agent-sdk': [
    {
      name: DEFAULT_AGENT_SDK_MODEL,
      isDefault: true,
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 4.6 fallback (2026-04); unpriced-meta, pricing not served',
    },
    {
      name: 'claude-opus-4-6',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      provenance: 'Anthropic Claude 4.6 fallback (2026-04); unpriced-meta, pricing not served',
    },
  ],
  anthropic: [
    {
      name: 'claude-sonnet-4-6',
      isDefault: true,
      contextLength: 1_000_000,
      ...CLAUDE_SONNET_46_PRICING,
      provenance:
        'Anthropic Claude 4.6 fallback (2026-04); cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-04-26',
    },
    {
      name: 'claude-opus-4-6',
      contextLength: 1_000_000,
      ...CLAUDE_OPUS_46_PRICING,
      provenance:
        'Anthropic Claude 4.6 fallback (2026-04); cache prices verified platform.claude.com/docs/en/about-claude/pricing 2026-04-26',
    },
  ],
  openrouter: [
    {
      name: 'anthropic/claude-sonnet-4.6',
      isDefault: true,
      catalogProvider: 'openrouter',
      provenance: 'Minimal bundled fallback (2026-04)',
    },
    {
      name: 'openrouter/free',
      isFree: true,
      provenance:
        'OpenRouter free pool; opportunistic fallback, not a reproducible default (2026-07)',
    },
  ],
  ollama: [
    {
      name: 'qwen3-coder:30b',
      isDefault: true,
      provenance: 'Ollama local model fallback; context limit discovered from the daemon (2026-07)',
    },
  ],
  'lm-studio': [
    {
      name: 'qwen2.5-coder-7b',
      isDefault: true,
      provenance:
        'LM Studio local model fallback; context limit discovered from the daemon (2026-07)',
    },
  ],
  deepseek: [
    {
      name: 'deepseek-v4-flash',
      isDefault: true,
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      pricingInput: 0.14,
      pricingOutput: 0.28,
      provenance: 'DeepSeek V4 Flash fallback (2026-07); 1M context and 384K maximum output',
    },
    {
      name: 'deepseek-v4-pro',
      contextLength: 1_000_000,
      maxOutputTokens: 384_000,
      pricingInput: 0.435,
      pricingOutput: 0.87,
      provenance: 'DeepSeek V4 Pro fallback (2026-07); 1M context and 384K maximum output',
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
      provenance:
        'OpenAI flagship fallback (2026-04); flat base rate, models.dev context_over_200k tiers not applied',
    },
    {
      name: 'gpt-5-codex',
      contextLength: 1_050_000,
      provenance: 'OpenAI coding-specialized fallback (2026-04)',
    },
  ],
  groq: [
    {
      name: 'openai/gpt-oss-120b',
      isDefault: true,
      contextLength: 131_072,
      maxOutputTokens: 65_536,
      provenance: 'Groq GPT OSS 120B recommendation; max_completion_tokens contract (2026-07)',
    },
  ],
  together: [
    {
      name: 'zai-org/GLM-5.1',
      isDefault: true,
      provenance: 'Together recommended Coding Agents model (2026-04)',
    },
  ],
};
