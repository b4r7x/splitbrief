import type { RunnerCallContext, RunnerCallResult } from '../../calls/types.js';
import type { ImplementerOptions } from '../types.js';
import { processError } from '../../../lib/process/errors.js';
import { isRecord } from '../../../utils/type-guards.js';

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

export function runnerCallFailureMessage(
  result: RunnerCallResult,
  signal: AbortSignal | undefined,
): string {
  if (result.status === 'completed') return 'Implementer call completed';
  if (result.status === 'aborted' && signal?.aborted) return 'Aborted';
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
