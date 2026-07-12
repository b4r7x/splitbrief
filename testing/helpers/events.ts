import type { EngineEvent } from '../../src/engine/events/types.js';
import { taskId } from '../../src/core/schemas/task.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export function makePlannerStatus(
  overrides?: Partial<EventOfType<'planner_status'>>,
): EventOfType<'planner_status'> {
  return {
    type: 'planner_status',
    ts: Date.now(),
    phase: 'implementing',
    status: 'running',
    ...overrides,
  };
}

export function makePlannerText(
  overrides?: Partial<EventOfType<'planner_text'>>,
): EventOfType<'planner_text'> {
  return {
    type: 'planner_text',
    ts: Date.now(),
    phase: 'implementing',
    text: 'Planning...',
    ...overrides,
  };
}

export function makeTaskStart(
  overrides?: Partial<EventOfType<'task_started'>>,
): EventOfType<'task_started'> {
  return {
    type: 'task_started',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Test task',
    index: 0,
    total: 3,
    file: 'src/test.ts',
    action: 'modify',
    ...overrides,
  };
}

export function makeTaskComplete(
  overrides?: Partial<EventOfType<'task_completed'>>,
): EventOfType<'task_completed'> {
  return {
    type: 'task_completed',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Test task',
    method: 'local',
    retries: 0,
    duration: 5000,
    ...overrides,
  };
}

export function makeTaskSkipped(
  overrides?: Partial<EventOfType<'task_skipped'>>,
): EventOfType<'task_skipped'> {
  return {
    type: 'task_skipped',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Test task',
    reason: 'dependency failed',
    ...overrides,
  };
}

type ImplementerGenerateEvent = Extract<
  EngineEvent,
  {
    type:
      | 'implementer_generate_running'
      | 'implementer_generate_done'
      | 'implementer_generate_failed';
  }
>;
type ImplementerGenerateRunningEvent = EventOfType<'implementer_generate_running'>;
type ImplementerGenerateDoneEvent = EventOfType<'implementer_generate_done'>;
type ImplementerGenerateFailedEvent = EventOfType<'implementer_generate_failed'>;

type RunningOverrides = Partial<Omit<ImplementerGenerateRunningEvent, 'type'>> & {
  status: 'running';
};
type DoneOverrides = Partial<Omit<ImplementerGenerateDoneEvent, 'type'>> & { status?: 'done' };
type FailedOverrides = Partial<Omit<ImplementerGenerateFailedEvent, 'type'>> & { status: 'failed' };

export function makeImplementerGenerate(
  overrides: RunningOverrides,
): ImplementerGenerateRunningEvent;
export function makeImplementerGenerate(overrides: FailedOverrides): ImplementerGenerateFailedEvent;
export function makeImplementerGenerate(overrides?: DoneOverrides): ImplementerGenerateDoneEvent;
export function makeImplementerGenerate(
  overrides?: RunningOverrides | DoneOverrides | FailedOverrides,
): ImplementerGenerateEvent {
  const base = {
    ts: Date.now(),
    phase: 'implementing' as const,
    taskId: taskId('T001'),
  };

  if (overrides?.status === 'running') {
    const { status: _status, ...rest } = overrides;
    return {
      type: 'implementer_generate_running',
      ...base,
      ...rest,
    };
  }
  if (overrides?.status === 'failed') {
    const { status: _status, ...rest } = overrides;
    return {
      type: 'implementer_generate_failed',
      ...base,
      model: 'qwen2.5-coder:7b',
      ...rest,
    };
  }
  const { status: _status, ...rest } = overrides ?? {};
  return {
    type: 'implementer_generate_done',
    ...base,
    file: 'src/test.ts',
    linesAdded: 10,
    linesRemoved: 2,
    duration: 5000,
    ...rest,
  };
}

export function makeValidate(
  overrides?: Partial<EventOfType<'validate'>>,
): EventOfType<'validate'> {
  return {
    type: 'validate',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    status: 'done',
    passed: true,
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

export function makeRetry(
  overrides?: Partial<EventOfType<'task_retry'>>,
): EventOfType<'task_retry'> {
  return {
    type: 'task_retry',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    attempt: 1,
    maxRetries: 3,
    error: '',
    ...overrides,
  };
}

export function makeErrorEvent(overrides?: Partial<EventOfType<'error'>>): EventOfType<'error'> {
  return {
    type: 'error',
    ts: Date.now(),
    phase: 'implementing',
    message: 'Something went wrong',
    ...overrides,
  };
}

const DEFAULT_TOKEN_USAGE = {
  plannerInput: 100,
  plannerOutput: 50,
  implementerInput: 200,
  implementerOutput: 100,
  escalationInput: 0,
  escalationOutput: 0,
};

export function makeCostUpdate(
  overrides?: Partial<EventOfType<'cost_update'>>,
): EventOfType<'cost_update'> {
  return {
    type: 'cost_update',
    ts: Date.now(),
    phase: 'implementing',
    tokenUsage: DEFAULT_TOKEN_USAGE,
    ...overrides,
  };
}

export function makeWorkflowCancelled(ts = Date.now()): EngineEvent {
  return { type: 'workflow_cancelled', ts, phase: 'implementing' };
}

export function makePlannerHeartbeat(
  overrides?: Partial<EventOfType<'planner_heartbeat'>>,
): EventOfType<'planner_heartbeat'> {
  return {
    type: 'planner_heartbeat',
    ts: Date.now(),
    phase: 'researching',
    elapsedMs: 500,
    accumulatedTokens: 5,
    ...overrides,
  };
}

export function makeTaskTokens(
  overrides?: Partial<EventOfType<'task_tokens'>>,
): EventOfType<'task_tokens'> {
  return {
    type: 'task_tokens',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    method: 'local',
    implementerTokens: 10,
    escalationTokens: 0,
    retryCount: 0,
    ...overrides,
  };
}

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
