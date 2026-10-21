import type { TaskId } from '../../../core/schemas/task.js';
import { seatAxisWords } from '../../../core/runners/effort-channel.js';
import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import { createRunnerCallId } from '../../calls/call-id.js';
import {
  runnerOutcome,
  type RunnerFailureOutcomeState,
  type RunnerOutcome,
} from '../../runners/errors.js';
import type { ImplementerOptions } from '../types.js';
import { processError } from '../../../lib/process/errors.js';
import { classifySeatFailure } from '../../runners/seat-failure.js';
import { isRecord } from '../../../utils/type-guards.js';

export const ABORTED_OUTCOME_TEXT = 'Aborted';

export function defaultShouldThrow(err: unknown): boolean {
  return processError.isNotFound(err);
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
  taskId: TaskId;
}): RunnerCallContext {
  const implementer = opts.config.implementer;
  const backendKind = opts.backendKind ?? implementer.kind;
  return {
    callId: createRunnerCallId('implementer'),
    role: 'implementer',
    backendKind,
    runnerName: implementerRunnerName(implementer),
    model: implementer.model,
    axes: seatAxisWords(implementer),
    attempt: opts.attempt,
    taskId: opts.taskId,
    // An API call's boundary is recorded by the completion that owns its one
    // HTTP request; a subprocess may make any number of provider requests.
    ...(backendKind !== 'api' && { usageBoundary: 'aggregate' as const }),
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
    case 'runner_call_tool_use_count_limit':
      return 'tool-use-limit';
    case 'spawn-not-found':
    case 'incompatible-version':
    case 'unauthenticated':
    case 'usage-limit':
    case 'input-too-large':
    case 'timeout':
    case 'no-progress-cut':
    case 'user-abort':
    case 'signal-exit':
    case 'non-zero-exit':
    case 'protocol-failure':
    case 'output-budget-breach':
    case 'callback-failure':
    case 'no-staged-change':
    case 'platform-limitation':
    case 'implementer-effect-invalid':
    case 'implementer-recipe-invalid':
    case 'implementer-left-isolation':
    case 'checkout-changed':
    case 'runner-timeout-repeated':
    case 'missing-model':
    case 'tool-use-limit':
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
  // cannot succeed. The one classifier reads it: an account refusal is a
  // usage-limit, a signed-out account is unauthenticated, and a limit whose
  // reset it names is a usage-limit too.
  const classification = classifySeatFailure({
    message: result.error.message,
    code: result.error.code,
    ...(result.error.status !== undefined && { status: result.error.status }),
    ...(result.error.providerType !== undefined && { providerType: result.error.providerType }),
    source: 'result-error',
  });
  if (classification.class === 'account') {
    return runnerOutcome.failure(
      classification.cause === 'auth' ? 'unauthenticated' : 'usage-limit',
    );
  }
  if (classification.class === 'rate-limited') {
    return runnerOutcome.failure('usage-limit');
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
  const message = result.error.message;
  return message.length > 0 ? message : runnerCallStatusMessage(result.status);
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

export function typedRunnerCallErrorCode(err: unknown): string | null {
  const callError = errorData(err)?.error;
  if (!isRecord(callError)) return null;
  return typeof callError.code === 'string' ? callError.code : null;
}

/**
 * The runner's own words for a failed call: the typed call error, else the raw
 * detail an API error keeps under its rewritten hint.
 */
export function runnerOwnWords(err: unknown): string | null {
  const detail = errorData(err)?.detail;
  return typedRunnerCallErrorMessage(err) ?? (typeof detail === 'string' ? detail : null);
}
