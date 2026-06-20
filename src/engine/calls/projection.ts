import type { TokenDelta } from '../../core/schemas/tokens.js';
import { error } from '../../utils/error.js';
import type { InvokeResult } from '../runners/types.js';
import { normalizeRunnerCallUsage, toTokenDeltaFromRunnerCallUsage } from './usage.js';
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

export function applyInvokeResultProjection(
  result: RunnerCallResult,
  projection: InvokeResult & { sessionId?: string | null | undefined },
): RunnerCallResult {
  return {
    ...result,
    text: projection.text,
    usage: normalizeRunnerCallUsage(projection.usage),
    nativeSessionId: projection.sessionId ?? result.nativeSessionId,
  };
}

export function toTokenDelta(usage: RunnerCallResult['usage']): TokenDelta | null {
  if (usage === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined && { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreateTokens !== undefined && { cacheCreateTokens: usage.cacheCreateTokens }),
  };
}
