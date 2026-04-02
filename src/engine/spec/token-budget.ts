import type { TokenBudget } from '../../types.js';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateMiddle(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 4);
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 50) / 2);
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
  const outputReserve = Math.floor(contextLength * 0.25);
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
