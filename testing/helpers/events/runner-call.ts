import type { EngineEvent } from '../../../src/engine/events/types.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

type RunnerCallActivityScenario = 'planner-read' | 'implementer-command';

const PLANNER_READ_ACTIVITY = {
  ts: 0,
  phase: 'researching',
  callId: 'call-1',
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'codex',
  sequence: 1,
  activityId: 'activity-1',
  stage: 'updated',
  kind: 'read',
  label: 'reading file.ts',
  redacted: false,
} satisfies Partial<EventOfType<'runner_call_activity'>>;

const LEGACY_ACTIVITY = {
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
} satisfies Partial<EventOfType<'runner_call_activity'>>;

const IMPLEMENTER_COMMAND_ACTIVITY = {
  ts: 2_500,
  phase: 'implementing',
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'codex',
  sequence: 2,
  activityId: 'call-1:tool:1',
  stage: 'completed',
  kind: 'command',
  label: 'running npm test',
  target: 'npm test',
  redacted: false,
} satisfies Partial<EventOfType<'runner_call_activity'>>;

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
): EventOfType<'runner_call_activity'>;
export function makeRunnerCallActivity(
  scenario: RunnerCallActivityScenario,
  overrides?: Partial<EventOfType<'runner_call_activity'>>,
): EventOfType<'runner_call_activity'>;
export function makeRunnerCallActivity(
  scenarioOrOverrides:
    | RunnerCallActivityScenario
    | Partial<EventOfType<'runner_call_activity'>> = 'implementer-command',
  overrides?: Partial<EventOfType<'runner_call_activity'>>,
): EventOfType<'runner_call_activity'> {
  const scenario = typeof scenarioOrOverrides === 'string' ? scenarioOrOverrides : undefined;
  const eventOverrides = typeof scenarioOrOverrides === 'string' ? overrides : scenarioOrOverrides;
  const defaults =
    scenario === 'planner-read'
      ? PLANNER_READ_ACTIVITY
      : scenario === 'implementer-command'
        ? IMPLEMENTER_COMMAND_ACTIVITY
        : LEGACY_ACTIVITY;
  return {
    type: 'runner_call_activity',
    ...defaults,
    ...eventOverrides,
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
