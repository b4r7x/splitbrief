import { isProviderId, stripVendorPrefix, type ProviderId } from '../../core/providers.js';
import type { TokenUsage, CostBreakdown } from '../../core/types/summary.js';

interface PricingInfo {
  inputPer1M: number;
  outputPer1M: number;
  isLocal: boolean;
  name: string;
}

const CLAUDE_OPUS_46: PricingInfo = { inputPer1M: 5, outputPer1M: 25, isLocal: false, name: 'Claude Opus 4.6' };
const CLAUDE_SONNET_46: PricingInfo = { inputPer1M: 3, outputPer1M: 15, isLocal: false, name: 'Claude Sonnet 4.6' };
const GPT_54: PricingInfo = { inputPer1M: 2.5, outputPer1M: 15, isLocal: false, name: 'GPT-5.4' };
const GPT_4O: PricingInfo = { inputPer1M: 2.50, outputPer1M: 10, isLocal: false, name: 'GPT-4o' };
const DEEPSEEK_CHAT: PricingInfo = { inputPer1M: 0.14, outputPer1M: 0.28, isLocal: false, name: 'DeepSeek V3' };

const LOCAL_PRICING: PricingInfo = { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'Local model' };

const MODEL_PRICING: Record<string, PricingInfo> = {
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75, isLocal: false, name: 'Claude Opus 4' },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15, isLocal: false, name: 'Claude Sonnet 4' },
  'claude-haiku-3-5': { inputPer1M: 0.80, outputPer1M: 4, isLocal: false, name: 'Claude Haiku 3.5' },
  'claude-sonnet-4.6': CLAUDE_SONNET_46,
  'claude-opus-4.6': CLAUDE_OPUS_46,
  'gpt-5.4': GPT_54,
  'gpt-4o': GPT_4O,
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60, isLocal: false, name: 'GPT-4o mini' },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8, isLocal: false, name: 'GPT-4.1' },
  'gpt-4.1-mini': { inputPer1M: 0.40, outputPer1M: 1.60, isLocal: false, name: 'GPT-4.1 mini' },
  'o3-mini': { inputPer1M: 1.10, outputPer1M: 4.40, isLocal: false, name: 'o3-mini' },
  'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.60, isLocal: false, name: 'Gemini 2.5 Flash' },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10, isLocal: false, name: 'Gemini 2.5 Pro' },
  'deepseek-chat': DEEPSEEK_CHAT,
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19, isLocal: false, name: 'DeepSeek Reasoner' },
  'mistral-small-3.1': { inputPer1M: 0.10, outputPer1M: 0.30, isLocal: false, name: 'Mistral Small 3.1' },
  'codestral': { inputPer1M: 0.30, outputPer1M: 0.90, isLocal: false, name: 'Codestral' },
};

function normalizeModelName(model: string): string {
  return stripVendorPrefix(model).replace(/-\d{8}$/, '');
}

export function getModelPricing(model: string): PricingInfo | undefined {
  const normalized = normalizeModelName(model);
  return MODEL_PRICING[normalized] ?? MODEL_PRICING[model];
}

const GROQ_LLAMA: PricingInfo = { inputPer1M: 0.05, outputPer1M: 0.08, isLocal: false, name: 'Groq Llama' };
const TOGETHER_LLAMA: PricingInfo = { inputPer1M: 0.20, outputPer1M: 0.20, isLocal: false, name: 'Together Llama' };

const TOOL_PRICING: Record<ProviderId, PricingInfo> = {
  'claude-code': { ...CLAUDE_OPUS_46, name: 'Claude Code' },
  codex: { ...GPT_54, name: 'Codex' },
  opencode: { ...CLAUDE_SONNET_46, name: 'OpenCode' },
  aider: { ...CLAUDE_SONNET_46, name: 'Aider' },
  copilot: { inputPer1M: 0, outputPer1M: 0, isLocal: false, name: 'Copilot' },
  'kilo-code': { inputPer1M: 0, outputPer1M: 0, isLocal: false, name: 'Kilo Code' },
  'agent-sdk': { ...CLAUDE_OPUS_46, name: 'Agent SDK' },
  anthropic: { ...CLAUDE_SONNET_46, name: 'Anthropic' },
  openrouter: { inputPer1M: 0.15, outputPer1M: 0.60, isLocal: false, name: 'OpenRouter' },
  deepseek: { ...DEEPSEEK_CHAT, name: 'DeepSeek' },
  openai: { ...GPT_4O, name: 'OpenAI' },
  groq: { ...GROQ_LLAMA, name: 'Groq' },
  together: { ...TOGETHER_LLAMA, name: 'Together AI' },
  ollama: LOCAL_PRICING,
  'lm-studio': LOCAL_PRICING,
  shell: LOCAL_PRICING,
  agent: LOCAL_PRICING,
};

export function getProviderPricing(tool: string): PricingInfo {
  if (!isProviderId(tool)) return LOCAL_PRICING;
  return TOOL_PRICING[tool];
}

export function calculateCost(inputTokens: number, outputTokens: number, pricing: PricingInfo): number {
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
         (outputTokens / 1_000_000) * pricing.outputPer1M;
}

export type CostBreakdownOptions = {
  tokenUsage: TokenUsage;
  totalTasks: number;
  escalatedCount: number;
  plannerTool: string;
  implementerTool: string;
};

export function calculateCostBreakdown(opts: CostBreakdownOptions): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, plannerTool, implementerTool } = opts;
  const plannerPricing = getProviderPricing(plannerTool);
  const implementerPricing = getProviderPricing(implementerTool);

  const hypotheticalCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, plannerPricing,
  );

  const plannerInputTotal = tokenUsage.plannerInput + tokenUsage.escalationInput;
  const plannerOutputTotal = tokenUsage.plannerOutput + tokenUsage.escalationOutput;

  const actualPlannerCost = calculateCost(plannerInputTotal, plannerOutputTotal, plannerPricing);

  const actualImplementerCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, implementerPricing,
  );

  const totalActualCost = actualPlannerCost + actualImplementerCost;
  const savingsAmount = hypotheticalCost - totalActualCost;
  const savingsPercentage = hypotheticalCost > 0 ? (savingsAmount / hypotheticalCost) * 100 : 0;
  // 0–1 ratio: 1 = all tasks completed locally, 0 = all escalated. Multiply by 100 only at display time.
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;

  const providerCosts: Record<string, { inputTokens: number; outputTokens: number; cost: number }> = {};
  if (actualPlannerCost > 0 || plannerInputTotal > 0 || plannerOutputTotal > 0) {
    providerCosts[plannerTool] = {
      inputTokens: plannerInputTotal,
      outputTokens: plannerOutputTotal,
      cost: actualPlannerCost,
    };
  }
  if (plannerTool !== implementerTool) {
    if (actualImplementerCost > 0 || tokenUsage.implementerInput > 0 || tokenUsage.implementerOutput > 0) {
      providerCosts[implementerTool] = {
        inputTokens: tokenUsage.implementerInput,
        outputTokens: tokenUsage.implementerOutput,
        cost: actualImplementerCost,
      };
    }
  } else {
    if (!providerCosts[plannerTool]) {
      providerCosts[plannerTool] = { inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    providerCosts[plannerTool].inputTokens += tokenUsage.implementerInput;
    providerCosts[plannerTool].outputTokens += tokenUsage.implementerOutput;
    providerCosts[plannerTool].cost += actualImplementerCost;
  }

  return {
    hypotheticalCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount: Math.max(0, savingsAmount),
    savingsPercentage: Math.max(0, savingsPercentage),
    localCompletionRate,
    providerCosts: Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
  };
}
