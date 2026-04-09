import { isProviderId, type ProviderId } from './catalog.js';
import type { TokenUsage, CostBreakdown } from '../types/summary.js';

export interface PricingInfo {
  inputPer1M: number;
  outputPer1M: number;
  isLocal: boolean;
  name: string;
}

const CLAUDE_OPUS_46: PricingInfo = { inputPer1M: 5, outputPer1M: 25, isLocal: false, name: 'Claude Opus 4.6' };
const CLAUDE_SONNET_46: PricingInfo = { inputPer1M: 3, outputPer1M: 15, isLocal: false, name: 'Claude Sonnet 4.6' };
const GPT_54: PricingInfo = { inputPer1M: 2.5, outputPer1M: 15, isLocal: false, name: 'GPT-5.4' };
const DEEPSEEK_CHAT: PricingInfo = { inputPer1M: 0.28, outputPer1M: 0.42, isLocal: false, name: 'DeepSeek V3' };

const LOCAL_PRICING: PricingInfo = { inputPer1M: 0, outputPer1M: 0, isLocal: true, name: 'Local model' };

const TOOL_PRICING: Record<ProviderId, PricingInfo> = {
  'claude-code': { ...CLAUDE_OPUS_46, name: 'Claude Code' },
  codex: { ...GPT_54, name: 'Codex' },
  opencode: { ...CLAUDE_SONNET_46, name: 'OpenCode' },
  aider: { ...CLAUDE_SONNET_46, name: 'Aider' },
  'agent-sdk': { ...CLAUDE_OPUS_46, name: 'Agent SDK' },
  anthropic: { ...CLAUDE_SONNET_46, name: 'Anthropic' },
  openrouter: { inputPer1M: 0.15, outputPer1M: 0.60, isLocal: false, name: 'OpenRouter' },
  ollama: LOCAL_PRICING,
  'lm-studio': LOCAL_PRICING,
  deepseek: { ...DEEPSEEK_CHAT, name: 'DeepSeek' },
  shell: LOCAL_PRICING,
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

  const actualPlannerCost = calculateCost(
    tokenUsage.plannerInput + tokenUsage.escalationInput,
    tokenUsage.plannerOutput + tokenUsage.escalationOutput,
    plannerPricing,
  );

  const actualImplementerCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, implementerPricing,
  );

  const totalActualCost = actualPlannerCost + actualImplementerCost;
  const savingsAmount = hypotheticalCost - totalActualCost;
  const savingsPercentage = hypotheticalCost > 0 ? (savingsAmount / hypotheticalCost) * 100 : 0;
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;

  return {
    hypotheticalCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount: Math.max(0, savingsAmount),
    savingsPercentage: Math.max(0, savingsPercentage),
    localCompletionRate,
  };
}
