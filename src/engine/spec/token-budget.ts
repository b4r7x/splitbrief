import type { TokenBudget } from '../../core/state/types.js';
import { estimateTokens, resolveCharsPerToken } from '../../core/tokens/estimate.js';

const OUTPUT_RESERVE_RATIO = 0.25;
const TRUNCATION_HEADER_WIDTH = 50;

// The context window assumed for an api backend that declares no contextLength and
// whose provider exposes no detected window. Both the prompt builder (currentCode
// truncation) and the request builder (max_tokens) resolve to this same value so an
// omitted contextLength never means "unlimited" to one consumer and 32768 to the other.
export const DEFAULT_API_CONTEXT_LENGTH = 32768;

export function truncateMiddle(text: string, maxTokens: number, modelId?: string): string {
  const charsPerToken = resolveCharsPerToken(modelId);
  const maxChars = Math.floor(maxTokens * charsPerToken);
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - TRUNCATION_HEADER_WIDTH) / 2);
  if (half <= 0) return text.slice(0, maxChars);
  return text.slice(0, half) + '\n// ... truncated to fit context window ...\n' + text.slice(-half);
}

export interface TokenBudgetInput {
  system: string;
  taskBody: string;
  contextLength: number;
  modelId?: string;
}

export function computeTokenBudget(input: TokenBudgetInput): TokenBudget {
  const { system, taskBody, contextLength, modelId } = input;
  const systemTokens = estimateTokens(system, modelId);
  const taskBodyTokens = estimateTokens(taskBody, modelId);
  const outputReserve = Math.floor(contextLength * OUTPUT_RESERVE_RATIO);
  const total = systemTokens + taskBodyTokens + outputReserve;
  const remaining = contextLength - total;

  return {
    system: systemTokens,
    taskBody: taskBodyTokens,
    outputReserve,
    total,
    remaining,
  };
}
