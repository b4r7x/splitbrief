import type { EngineEvent } from '../../../src/engine/events/types.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export function makeRunnerCallStalled(
  overrides?: Partial<EventOfType<'runner_call_stalled'>>,
): EventOfType<'runner_call_stalled'> {
  return {
    type: 'runner_call_stalled',
    ts: 2_000,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 1,
    silentMs: 60_000,
    ...overrides,
  };
}

export function makeRunnerCallStallCleared(
  overrides?: Partial<EventOfType<'runner_call_stall_cleared'>>,
): EventOfType<'runner_call_stall_cleared'> {
  return {
    type: 'runner_call_stall_cleared',
    ts: 2_500,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    ...overrides,
  };
}

export function makeRunnerCallStarted(
  overrides?: Partial<EventOfType<'runner_call_started'>>,
): EventOfType<'runner_call_started'> {
  return {
    type: 'runner_call_started',
    ts: 3_000,
    phase: 'implementing',
    callId: 'call-2',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 3,
    ...overrides,
  };
}

export function makeRunnerCallActivity(
  overrides?: Partial<EventOfType<'runner_call_activity'>>,
): EventOfType<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: 2_500,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    activityId: 'call-1:tool:1',
    stage: 'completed',
    kind: 'command',
    label: 'running npm test',
    redacted: false,
    ...overrides,
  };
}

export function makeRunnerCallCompleted(
  overrides?: Partial<EventOfType<'runner_call_completed'>>,
): EventOfType<'runner_call_completed'> {
  return {
    type: 'runner_call_completed',
    ts: 2_500,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    status: 'completed',
    error: null,
    partial: false,
    startedAt: 1_000,
    endedAt: 2_500,
    durationMs: 1_500,
    usage: null,
    nativeSessionId: null,
    ...overrides,
  };
}

export function makeRunnerCallError(
  overrides?: Partial<EventOfType<'runner_call_error'>>,
): EventOfType<'runner_call_error'> {
  return {
    type: 'runner_call_error',
    ts: 2_500,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    status: 'failed',
    error: { code: 'failed', message: 'failed' },
    partial: true,
    startedAt: 1_000,
    endedAt: 2_500,
    durationMs: 1_500,
    usage: null,
    nativeSessionId: null,
    ...overrides,
  };
}
