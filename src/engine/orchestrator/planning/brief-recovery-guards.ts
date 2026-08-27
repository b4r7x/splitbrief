import type { RecoveryUsage } from '../../../core/schemas/brief-recovery/budget.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { RunnerCallUsage } from '../../calls/types.js';
import { isRecord } from '../../../utils/type-guards.js';

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function toRecoveryUsage(usage: unknown): RecoveryUsage | null {
  if (!isSafeTokenUsage(usage)) return null;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: false,
  };
}

export function isSafeTokenUsage(usage: unknown): usage is RunnerCallUsage | TokenDelta {
  if (!isRecord(usage)) return false;
  return (
    isSafeTokenCount(usage.inputTokens) &&
    isSafeTokenCount(usage.outputTokens) &&
    isSafeOptionalTokenCount(usage.cacheReadTokens) &&
    isSafeOptionalTokenCount(usage.cacheCreateTokens) &&
    isSafeOptionalTokenCount(usage.reasoningTokens)
  );
}

function isSafeOptionalTokenCount(value: unknown): boolean {
  return value === undefined || isSafeTokenCount(value);
}

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
