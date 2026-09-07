import type { EffortLevel, ProviderId } from '../schemas/enums.js';

export type ModelRecommendation = 'recommended' | 'compatible-only';

/**
 * The models.dev vendor whose catalog row carries a bundled model's pricing and
 * limits. A catalog identity only — never a runner the user can configure.
 */
export type CatalogVendorId = 'anthropic' | 'openai' | 'openrouter';

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
  catalogProvider?: CatalogVendorId;
  catalogModelId?: string;
  provenance?: string;
}

/**
 * The ladder a tool's own `--effort` flag accepts, read from the tool's help output.
 * It is a floor for rows no catalog knows — a model's own published ladder always wins.
 * `exhaustive` is false when the help documents an example rather than a closed set, so
 * the ladder may order an offer but must never be used to reject a carried value.
 */
interface ToolEffortLadder {
  readonly levels: readonly EffortLevel[];
  readonly exhaustive: boolean;
  readonly provenance: string;
}

export const TOOL_EFFORT_LADDERS: Readonly<Partial<Record<ProviderId, ToolEffortLadder>>> =
  Object.freeze({
    'claude-code': {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      exhaustive: true,
      provenance: 'claude --help 2.1.263 (2026-09-07): "(low, medium, high, xhigh, max)"',
    },
    copilot: {
      levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      exhaustive: true,
      provenance: 'copilot --help 1.0.77 (2026-09-07): choices: "none", … , "max"',
    },
    'command-code': {
      levels: ['low', 'medium', 'high'],
      exhaustive: false,
      provenance:
        'cmd --help 1.50.0 (2026-09-07): "(e.g. low, medium, high) — depends on the model"; cmd --list-models publishes no per-model levels',
    },
  });

export const PENDING_EVALUATION_CANDIDATE_IDS = Object.freeze([
  { provider: 'ollama', model: 'qwen3-coder:30b' },
  { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
] as const satisfies readonly { provider: ProviderId; model: string }[]);

// `recommended` is reserved for a model with recorded T-080 evaluation metrics.
// No credentialed evaluation run exists, so every bundled row is compatible-only.
function compatibleModel(model: Omit<KnownModel, 'recommendation'>): KnownModel {
  return { ...model, recommendation: 'compatible-only' };
}

export const KNOWN_MODELS: Partial<Record<ProviderId, KnownModel[]>> = {
  'claude-code': [
    compatibleModel({
      name: 'default',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'best',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'fable',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-fable-5',
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
      name: 'sonnet',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'haiku',
      contextLength: 200_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-haiku-4-5',
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
      name: 'sonnet[1m]',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-5',
      provenance: 'Claude Code model aliases (2026-08); code.claude.com/docs/en/model-config',
    }),
    compatibleModel({
      name: 'opus[1m]',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
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
};
