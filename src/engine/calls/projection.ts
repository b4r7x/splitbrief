import type { TokenDelta } from '../../core/schemas/tokens.js';
import { error } from '../../utils/error.js';
import type { InvokeResult } from '../runners/types.js';
import { toTokenDeltaFromRunnerCallUsage } from './usage.js';
import type { RunnerCallResult } from './types.js';

export function toInvokeResult(result: RunnerCallResult): InvokeResult {
  if (result.status !== 'completed') {
    throw error(
      'runner-call-not-completed',
      `Cannot project ${result.status} runner call to InvokeResult`,
      {
        callId: result.callId,
        status: result.status,
        partial: result.partial,
      },
    );
  }
  return {
    text: result.text,
    usage: result.usage === null ? null : toTokenDeltaFromRunnerCallUsage(result.usage),
  };
}

export function toTokenDelta(usage: RunnerCallResult['usage']): TokenDelta | null {
  if (usage === null) return null;
  return toTokenDeltaFromRunnerCallUsage(usage);
}
