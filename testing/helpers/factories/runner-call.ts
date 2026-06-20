import type { RunnerCallResult } from '../../../src/engine/calls/types.js';

type CompletedRunnerCallResult = Extract<RunnerCallResult, { status: 'completed' }>;
type FailedRunnerCallResult = Exclude<RunnerCallResult, CompletedRunnerCallResult>;

export function makeRunnerCallResult(
  overrides: Pick<CompletedRunnerCallResult, 'status' | 'text'> &
    Partial<Omit<CompletedRunnerCallResult, 'status' | 'text'>>,
): CompletedRunnerCallResult;
export function makeRunnerCallResult(
  overrides: Pick<FailedRunnerCallResult, 'status' | 'text' | 'error'> &
    Partial<Omit<FailedRunnerCallResult, 'status' | 'text' | 'error'>>,
): FailedRunnerCallResult;
export function makeRunnerCallResult(
  overrides:
    | (Pick<CompletedRunnerCallResult, 'status' | 'text'> &
        Partial<Omit<CompletedRunnerCallResult, 'status' | 'text'>>)
    | (Pick<FailedRunnerCallResult, 'status' | 'text' | 'error'> &
        Partial<Omit<FailedRunnerCallResult, 'status' | 'text' | 'error'>>),
): RunnerCallResult {
  const base: Pick<
    RunnerCallResult,
    | 'callId'
    | 'role'
    | 'backendKind'
    | 'startedAt'
    | 'endedAt'
    | 'durationMs'
    | 'usage'
    | 'nativeSessionId'
    | 'toolUses'
    | 'artifacts'
    | 'warnings'
  > = {
    callId: 'call-test',
    role: 'implementer',
    backendKind: 'api',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  };

  if (overrides.status === 'completed') {
    return {
      ...base,
      ...overrides,
      status: 'completed',
      error: null,
      partial: false,
    };
  }

  return {
    ...base,
    ...overrides,
    partial: overrides.partial ?? true,
  };
}
