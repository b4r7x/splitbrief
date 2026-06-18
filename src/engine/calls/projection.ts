import type { TokenDelta } from '../../core/schemas/tokens.js';
import { error } from '../../utils/error.js';
import type { InvokeResult } from '../runners/types.js';
import { normalizeRunnerCallUsage, toTokenDeltaFromRunnerCallUsage } from './usage.js';
import type { RunnerCallContext, RunnerCallResult } from './types.js';

export type RunnerCallCompatibleResult =
  | RunnerCallResult
  | (InvokeResult & { sessionId?: string | null | undefined });

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

export function toRunnerCallResult(
  context: RunnerCallContext,
  result: RunnerCallCompatibleResult,
): RunnerCallResult {
  if (isRunnerCallResult(result)) return result;

  const now = Date.now();
  return {
    callId: context.callId,
    role: context.role,
    backendKind: context.backendKind,
    ...(context.runnerName !== undefined && { runnerName: context.runnerName }),
    ...(context.model !== undefined && { model: context.model }),
    ...(context.attempt !== undefined && { attempt: context.attempt }),
    status: 'completed',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    text: result.text,
    usage: normalizeRunnerCallUsage(result.usage),
    nativeSessionId: result.sessionId ?? null,
    toolUses: [],
    artifacts: [],
    warnings: [],
    error: null,
    partial: false,
  };
}

function isRunnerCallResult(result: RunnerCallCompatibleResult): result is RunnerCallResult {
  return 'callId' in result && 'status' in result && 'backendKind' in result;
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
