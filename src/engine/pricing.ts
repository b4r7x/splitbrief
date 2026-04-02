export interface PricingInfo {
  inputPer1M: number;
  outputPer1M: number;
  isLocal: boolean;
  name: string;
}

const PRICING: Record<string, PricingInfo> = {
  'claude-opus-4-6': { inputPer1M: 5, outputPer1M: 25, isLocal: false, name: 'Claude Opus 4.6' },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15, isLocal: false, name: 'Claude Sonnet 4.6' },
  'claude-haiku-4-5': { inputPer1M: 1, outputPer1M: 5, isLocal: false, name: 'Claude Haiku 4.5' },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, isLocal: false, name: 'GPT-4o' },
  'o3': { inputPer1M: 2, outputPer1M: 8, isLocal: false, name: 'o3' },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4, isLocal: false, name: 'o4-mini' },
  'deepseek-chat': { inputPer1M: 0.28, outputPer1M: 0.42, isLocal: false, name: 'DeepSeek V3' },
  'deepseek-reasoner': { inputPer1M: 0.28, outputPer1M: 0.42, isLocal: false, name: 'DeepSeek R1' },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10, isLocal: false, name: 'Gemini 2.5 Pro' },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, isLocal: false, name: 'Gemini 2.5 Flash' },
};

const LOCAL_PRICING: PricingInfo = { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'Local model' };

const DEFAULT_PLANNER_PRICING: Record<string, PricingInfo> = {
  'claude-code': { ...PRICING['claude-opus-4-6'], name: 'Claude Code (Opus)' },
  'codex': { ...PRICING['o4-mini'], name: 'Codex (o4-mini)' },
  'opencode': { ...PRICING['claude-sonnet-4-6'], name: 'OpenCode' },
  'aider': { ...PRICING['claude-sonnet-4-6'], name: 'Aider' },
  'agent-sdk': { ...PRICING['claude-opus-4-6'], name: 'Agent SDK (Opus)' },
};

export function getPricing(modelOrProvider: string): PricingInfo {
  return PRICING[modelOrProvider] ?? LOCAL_PRICING;
}

export function getPlannerPricing(tool: string): PricingInfo {
  return DEFAULT_PLANNER_PRICING[tool] ?? LOCAL_PRICING;
}

const IMPLEMENTER_PRICING: Record<string, PricingInfo> = {
  ollama: LOCAL_PRICING,
  'lm-studio': LOCAL_PRICING,
  deepseek: { ...PRICING['deepseek-chat'], name: 'DeepSeek V3' },
  openrouter: { inputPer1M: 0.15, outputPer1M: 0.60, isLocal: false, name: 'OpenRouter' },
  shell: LOCAL_PRICING,
};

export function getImplementerPricing(provider: string): PricingInfo {
  return IMPLEMENTER_PRICING[provider] ?? LOCAL_PRICING;
}

export function calculateCost(inputTokens: number, outputTokens: number, pricing: PricingInfo): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
         (outputTokens / 1_000_000) * pricing.outputPer1M;
}
