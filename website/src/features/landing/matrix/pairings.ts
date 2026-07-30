import {
  type ImplementerRunnerConfig,
  type PlannerRunnerConfig,
  serializePairingConfig,
} from './serialize-config.js';

const MODEL_VERIFIED_ON = '2026-07-30';
const ANTHROPIC_MODEL_SOURCE =
  'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions';

export const PLANNER_JACK_IDS = [
  'claude-code',
  'codex',
  'opencode',
  'aider',
  'anthropic',
  'agent-sdk',
] as const;

export const IMPLEMENTER_JACK_IDS = [
  'ollama',
  'lm-studio',
  'deepseek',
  'groq',
  'openrouter',
  'together',
] as const;

export type PlannerJackId = (typeof PLANNER_JACK_IDS)[number];
export type ImplementerJackId = (typeof IMPLEMENTER_JACK_IDS)[number];

export const PLANNER_JACKS = {
  'claude-code': {
    label: 'Claude Code',
    runner: { kind: 'cli', tool: 'claude-code' },
  },
  codex: {
    label: 'Codex',
    runner: { kind: 'cli', tool: 'codex' },
  },
  opencode: {
    label: 'OpenCode',
    runner: { kind: 'cli', tool: 'opencode' },
  },
  aider: {
    label: 'Aider',
    runner: { kind: 'cli', tool: 'aider' },
  },
  anthropic: {
    label: 'Anthropic',
    runner: {
      kind: 'api',
      provider: 'anthropic',
      apiBase: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-6',
    },
  },
  'agent-sdk': {
    label: 'Agent SDK',
    runner: {
      kind: 'agent-sdk',
      model: 'claude-sonnet-4-6',
    },
  },
} as const satisfies Record<
  PlannerJackId,
  { readonly label: string; readonly runner: PlannerRunnerConfig }
>;

export const IMPLEMENTER_JACKS = {
  ollama: {
    label: 'Ollama',
    runner: {
      kind: 'api',
      provider: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen3-coder:30b',
    },
  },
  'lm-studio': {
    label: 'LM Studio',
    runner: {
      kind: 'api',
      provider: 'lm-studio',
      apiBase: 'http://localhost:1234/v1',
      model: 'qwen2.5-coder-7b',
    },
  },
  deepseek: {
    label: 'DeepSeek',
    runner: {
      kind: 'api',
      provider: 'deepseek',
      apiBase: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    },
  },
  groq: {
    label: 'Groq',
    runner: {
      kind: 'api',
      provider: 'groq',
      apiBase: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b',
    },
  },
  openrouter: {
    label: 'OpenRouter',
    runner: {
      kind: 'api',
      provider: 'openrouter',
      apiBase: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    },
  },
  together: {
    label: 'Together AI',
    runner: {
      kind: 'api',
      provider: 'together',
      apiBase: 'https://api.together.xyz/v1',
      model: 'zai-org/GLM-5.1',
    },
  },
} as const satisfies Record<
  ImplementerJackId,
  { readonly label: string; readonly runner: ImplementerRunnerConfig }
>;

export const MODEL_PROVENANCE = {
  anthropic: {
    model: PLANNER_JACKS.anthropic.runner.model,
    modelSourceUrl: ANTHROPIC_MODEL_SOURCE,
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  'agent-sdk': {
    model: PLANNER_JACKS['agent-sdk'].runner.model,
    modelSourceUrl: ANTHROPIC_MODEL_SOURCE,
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  ollama: {
    model: IMPLEMENTER_JACKS.ollama.runner.model,
    modelSourceUrl: 'https://ollama.com/library/qwen3-coder',
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  'lm-studio': {
    model: IMPLEMENTER_JACKS['lm-studio'].runner.model,
    modelSourceUrl: 'https://lmstudio.ai/models/qwen/qwen2.5-coder-7b',
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  deepseek: {
    model: IMPLEMENTER_JACKS.deepseek.runner.model,
    modelSourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  groq: {
    model: IMPLEMENTER_JACKS.groq.runner.model,
    modelSourceUrl: 'https://console.groq.com/docs/models',
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  openrouter: {
    model: IMPLEMENTER_JACKS.openrouter.runner.model,
    modelSourceUrl: 'https://openrouter.ai/anthropic/claude-sonnet-4.6',
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
  together: {
    model: IMPLEMENTER_JACKS.together.runner.model,
    modelSourceUrl: 'https://docs.together.ai/docs/inference/recommended-models',
    modelVerifiedOn: MODEL_VERIFIED_ON,
  },
} as const;

export interface PairingSelection {
  readonly plannerId: PlannerJackId;
  readonly implementerId: ImplementerJackId;
}

export const DEFAULT_SELECTION = {
  plannerId: 'claude-code',
  implementerId: 'ollama',
} as const satisfies PairingSelection;

export function pairingYaml({ plannerId, implementerId }: PairingSelection): string {
  return serializePairingConfig({
    planner: PLANNER_JACKS[plannerId].runner,
    implementer: IMPLEMENTER_JACKS[implementerId].runner,
  });
}
