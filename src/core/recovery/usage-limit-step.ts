import { SOFT_SEP } from '../separators.js';
import { formatStoredReset } from './reset-clock.js';

export const USAGE_LIMIT_STEPS = [70, 75, 80, 85, 90, 95] as const;
export type UsageLimitStep = (typeof USAGE_LIMIT_STEPS)[number];

export const USAGE_LIMIT_WINDOWS = ['five_hour', 'seven_day'] as const;
export type UsageLimitWindow = (typeof USAGE_LIMIT_WINDOWS)[number];

export function usageLimitStep(percent: number): UsageLimitStep | null {
  if (!Number.isFinite(percent) || percent < 70 || percent >= 100) {
    return null;
  }
  let step: UsageLimitStep | null = null;
  for (const candidate of USAGE_LIMIT_STEPS) {
    if (percent >= candidate) step = candidate;
  }
  return step;
}

function windowLimitPhrase(window: UsageLimitWindow): string {
  return window === 'five_hour' ? '5-hour limit' : 'weekly limit';
}

export function formatUsageLimitWarning(
  input: Readonly<{
    step: UsageLimitStep;
    tool: string;
    window: UsageLimitWindow;
    resetsAt?: number | undefined;
  }>,
): string {
  const base = `You've used ${input.step}% of your ${input.tool} ${windowLimitPhrase(input.window)}`;
  if (input.resetsAt === undefined) return base;
  return `${base}${SOFT_SEP}resets ${formatStoredReset(input.resetsAt)}`;
}
