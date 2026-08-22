import type { EngineEvent } from '../../../src/engine/events/types.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { makeUsage } from '../factories/summary.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

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

const DEFAULT_TOKEN_USAGE = makeUsage({
  plannerInput: 100,
  plannerOutput: 50,
  implementerInput: 200,
  implementerOutput: 100,
});

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
