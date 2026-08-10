import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import {
  runnerOutcome,
  type RunnerFailureOutcomeState,
  type RunnerOutcome,
} from '../../runners/errors.js';
import type { ImplementerOptions } from '../types.js';
import { processError } from '../../../lib/process/errors.js';
import { isAuthFailureDiagnostic } from '../../runners/auth-failure.js';
import { isUsageLimitDiagnostic } from '../../runners/usage-limit.js';
import { isRecord } from '../../../utils/type-guards.js';

export const ABORTED_OUTCOME_TEXT = 'Aborted';

let implementerCallSequence = 0;

export function defaultShouldThrow(err: unknown): boolean {
  return processError.isNotFound(err) || processError.isTimeout(err);
}

function implementerRunnerName(config: ImplementerOptions['config']['implementer']): string {
  switch (config.kind) {
    case 'api':
      return config.provider;
    case 'cli':
      return config.tool;
    case 'shell':
    case 'agent':
      return config.command;
    case 'agent-sdk':
      return 'agent-sdk';
    default: {
      const _exhaustive: never = config;
      return _exhaustive;
    }
  }
}

export function createImplementerCallContext(opts: {
  config: ImplementerOptions['config'];
  backendKind?: RunnerCallContext['backendKind'] | undefined;
  attempt: number;
}): RunnerCallContext {
  const implementer = opts.config.implementer;
  return {
    callId: `implementer-${++implementerCallSequence}`,
    role: 'implementer',
    backendKind: opts.backendKind ?? implementer.kind,
    runnerName: implementerRunnerName(implementer),
    model: implementer.model,
    attempt: opts.attempt,
  };
}

function runnerCallStatusMessage(status: Exclude<RunnerCallResult['status'], 'completed'>): string {
  switch (status) {
    case 'failed':
      return 'Implementer call failed';
    case 'truncated':
      return 'Implementer call was truncated';
    case 'aborted':
      return 'Implementer call was aborted';
    case 'timeout':
      return 'Implementer call timed out';
    case 'refused':
      return 'Implementer refused the request';
    case 'unsupported_tool':
      return 'Implementer used an unsupported tool';
    case 'incomplete':
      return 'Implementer call was incomplete';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function failureStateFromCode(code: string): RunnerFailureOutcomeState | null {
  switch (code) {
    case 'spawn-not-found':
    case 'incompatible-version':
    case 'unauthenticated':
    case 'usage-limit':
    case 'timeout':
    case 'user-abort':
    case 'signal-exit':
    case 'non-zero-exit':
    case 'protocol-failure':
    case 'output-budget-breach':
    case 'callback-failure':
    case 'no-staged-change':
    case 'platform-limitation':
      return code;
    default:
      return null;
  }
}

export function runnerCallOutcome(result: RunnerCallResult): RunnerOutcome {
  if (result.status === 'completed') return runnerOutcome.success();

  const stableState = failureStateFromCode(result.error.code);
  if (stableState !== null) return runnerOutcome.failure(stableState);

  // Subscription CLIs report an exhausted quota and a dead login alike as
  // ordinary turn failures (codex: `codex-turn-failed`, claude:
  // `runner_result_error`); the message is the only signal that retrying
  // cannot succeed. Limits are checked first: a limit message must never
  // earn login advice, because logging in does not restore quota.
  if (isUsageLimitDiagnostic(result.error.message)) {
    return runnerOutcome.failure('usage-limit');
  }
  if (isAuthFailureDiagnostic(result.error.message)) {
    return runnerOutcome.failure('unauthenticated');
  }

  switch (result.status) {
    case 'failed':
    case 'refused':
    case 'incomplete':
      return runnerOutcome.failure('protocol-failure');
    case 'truncated':
      return runnerOutcome.failure('output-budget-breach');
    case 'aborted':
      return runnerOutcome.failure('user-abort');
    case 'timeout':
      return runnerOutcome.failure('timeout');
    case 'unsupported_tool':
      return runnerOutcome.failure('platform-limitation');
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export function runnerCallFailureMessage(
  result: RunnerCallResult,
  signal: AbortSignal | undefined,
): string {
  if (result.status === 'completed') return 'Implementer call completed';
  if (result.status === 'aborted' && signal?.aborted) return ABORTED_OUTCOME_TEXT;
  return result.error?.message ?? runnerCallStatusMessage(result.status);
}

function errorData(err: unknown): Record<string, unknown> | null {
  if (!isRecord(err)) return null;
  return isRecord(err.data) ? err.data : null;
}

export function errorOutput(err: unknown): string {
  if (isRecord(err) && typeof err.output === 'string') return err.output;
  const data = errorData(err);
  return typeof data?.output === 'string' ? data.output : '';
}

export function typedRunnerCallErrorMessage(err: unknown): string | null {
  const data = errorData(err);
  if (!data) return null;
  const callError = data.error;
  if (!isRecord(callError)) return null;
  return typeof callError.message === 'string' ? callError.message : null;
}
