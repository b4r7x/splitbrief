import type { TokenBudget } from '../../core/state/types.js';
import { estimateTokens } from '../../core/tokens/estimate.js';

export { estimateTokens };

const CHARS_PER_TOKEN = 4;
const OUTPUT_RESERVE_RATIO = 0.25;
const TRUNCATION_HEADER_WIDTH = 50;

export function truncateMiddle(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - TRUNCATION_HEADER_WIDTH) / 2);
  if (half <= 0) return text.slice(0, maxChars);
  return text.slice(0, half) + '\n// ... truncated to fit context window ...\n' + text.slice(-half);
}

export function computeTokenBudget(
  system: string,
  taskBody: string,
  contextLength: number,
): TokenBudget {
  const systemTokens = estimateTokens(system);
  const taskBodyTokens = estimateTokens(taskBody);
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
