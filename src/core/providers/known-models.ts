import type { EffortLevel, ProviderId } from '../schemas/enums.js';

export type ModelRecommendation = 'recommended' | 'compatible-only';

/**
 * The models.dev vendor whose catalog row carries a bundled model's pricing and
 * limits. A catalog identity only — never a runner the user can configure.
 */
export type CatalogVendorId = 'anthropic' | 'openai' | 'openrouter' | 'github-copilot';

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
  /** The tool's own label for this selection, as its picker spells it. */
  displayName?: string;
  /** One line the row's metadata column carries beside the id. */
  detail?: string;
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
    codex: {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      exhaustive: false,
      provenance:
        'codex debug models --bundled 0.153.3 (2026-09-08): per-model supported_reasoning_levels, union minus the unrepresentable `ultra`',
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

/**
 * The nine labels below come from three sources, read off the newest installed build: the
 * `/model` menu's own `label` where the binary carries one, the baked catalog's `display_name`
 * otherwise (`fable[1m]` derived the way the binary derives it, `display_name + " (1M context)"`,
 * shortened to ` (1M)` here because the row's own detail already reads `forces the 1M window`),
 * and SPLITBRIEF's own title-cased alias for `best`, which has no label record in the binary.
 * The row order is ours — plain aliases, then behavioural, then window variants; the binary ships
 * no ordered menu record, and its alias validity array orders them differently.
 *
 * Each window is that same baked record's `context.window` — `1e6` for `claude-sonnet-5`,
 * `claude-opus-5` and `claude-fable-5-1`, `200000` for `claude-haiku-4-5` — so it is Claude's
 * own number beside Claude's own label, not one we typed. For a CLI tool's rows the declared
 * window is the answer everywhere — what the picker row shows, and what an `auto` seat floors
 * to (REQ-D26, REQ-B08); `catalogProvider`/`catalogModelId` document the full catalog id each
 * alias resolves to and are never read for lookups (models.dev serves `api` runners only).
 */
const CLAUDE_ALIAS_PROVENANCE =
  'Claude Code 2.1.267 /model menu + baked catalog display_name & context.window + alias table (2026-09-10); code.claude.com/docs/en/model-config';

export const KNOWN_MODELS: Partial<Record<ProviderId, KnownModel[]>> = {
  'claude-code': [
    compatibleModel({
      name: 'sonnet',
      displayName: 'Sonnet 5',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'opus',
      displayName: 'Opus 5',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'fable',
      displayName: 'Fable 5.1',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-fable-5-1',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'haiku',
      displayName: 'Haiku 4.5',
      contextLength: 200_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-haiku-4-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'opusplan',
      displayName: 'Opus 5 Plan Mode',
      detail: 'Opus plans, Sonnet builds',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'best',
      displayName: 'Best',
      detail: 'latest Fable, else Opus',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'sonnet[1m]',
      displayName: 'Sonnet 5 (1M)',
      detail: 'forces the 1M window',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-sonnet-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'opus[1m]',
      displayName: 'Opus 5 (1M)',
      detail: 'forces the 1M window',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-opus-5',
      provenance: CLAUDE_ALIAS_PROVENANCE,
    }),
    compatibleModel({
      name: 'fable[1m]',
      displayName: 'Fable 5.1 (1M)',
      detail: 'forces the 1M window',
      contextLength: 1_000_000,
      catalogProvider: 'anthropic',
      catalogModelId: 'claude-fable-5-1',
      provenance: CLAUDE_ALIAS_PROVENANCE,
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
    // Both rows keep their window: bundledMinimumWindow (context-window.ts) floors an
    // offline `auto` seat on these numbers.
    compatibleModel({
      name: 'claude-opus-5',
      contextLength: 1_000_000,
      catalogProvider: 'github-copilot',
      catalogModelId: 'claude-opus-5',
      provenance: 'Offline floor for the copilot help config listing (2026-09-02)',
    }),
    compatibleModel({
      name: 'gpt-5.6-sol',
      contextLength: 1_050_000,
      catalogProvider: 'github-copilot',
      catalogModelId: 'gpt-5.6-sol',
      provenance: 'Offline floor for the copilot help config listing (2026-09-02)',
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
