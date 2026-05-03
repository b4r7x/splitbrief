import type { EngineEvent } from '../../src/engine/events/types.js';
import { taskId } from '../../src/core/schemas/task.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

export function makePlannerStatus(overrides?: Partial<EventOfType<'planner_status'>>): EventOfType<'planner_status'> {
  return { type: 'planner_status', ts: Date.now(), phase: 'implementing', status: 'running', ...overrides };
}

export function makePlannerText(overrides?: Partial<EventOfType<'planner_text'>>): EventOfType<'planner_text'> {
  return { type: 'planner_text', ts: Date.now(), phase: 'implementing', text: 'Planning...', ...overrides };
}

export function makeTaskStart(overrides?: Partial<EventOfType<'task_started'>>): EventOfType<'task_started'> {
  return { type: 'task_started', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), title: 'Test task', index: 0, total: 3, file: 'src/test.ts', action: 'modify', ...overrides };
}

export function makeTaskComplete(overrides?: Partial<EventOfType<'task_completed'>>): EventOfType<'task_completed'> {
  return { type: 'task_completed', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), title: 'Test task', method: 'local', retries: 0, duration: 5000, ...overrides };
}

export function makeTaskSkipped(overrides?: Partial<EventOfType<'task_skipped'>>): EventOfType<'task_skipped'> {
  return { type: 'task_skipped', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), title: 'Test task', reason: 'dependency failed', ...overrides };
}

type ImplementerGenerateEvent = Extract<
  EngineEvent,
  { type: 'implementer_generate_running' | 'implementer_generate_done' | 'implementer_generate_failed' }
>;

export function makeImplementerGenerate(overrides?: Record<string, unknown>): ImplementerGenerateEvent {
  const status = (overrides?.status as string) ?? 'done';
  const { status: _drop, ...rest } = overrides ?? {};
  if (status === 'running') {
    return { type: 'implementer_generate_running', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), ...rest } as ImplementerGenerateEvent;
  }
  if (status === 'failed') {
    return { type: 'implementer_generate_failed', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), model: 'qwen2.5-coder:7b', ...rest } as ImplementerGenerateEvent;
  }
  return { type: 'implementer_generate_done', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), file: 'src/test.ts', linesAdded: 10, linesRemoved: 2, duration: 5000, ...rest } as ImplementerGenerateEvent;
}

export function makeValidate(overrides?: Partial<EventOfType<'validate'>>): EventOfType<'validate'> {
  return { type: 'validate', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), status: 'done', passed: true, stages: { typecheck: true, lint: true, test: true }, ...overrides };
}

export function makeRetry(overrides?: Partial<EventOfType<'task_retry'>>): EventOfType<'task_retry'> {
  return { type: 'task_retry', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), attempt: 1, maxRetries: 3, error: '', ...overrides };
}

export function makeEscalate(overrides?: Partial<EventOfType<'escalate'>>): EventOfType<'escalate'> {
  return { type: 'escalate', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), tier: 1, ...overrides };
}

export function makeGitCommit(overrides?: Partial<EventOfType<'git_commit'>>): EventOfType<'git_commit'> {
  return { type: 'git_commit', ts: Date.now(), phase: 'implementing', taskId: taskId('T001'), message: 'feat: implement test task', ...overrides };
}

export function makeErrorEvent(overrides?: Partial<EventOfType<'error'>>): EventOfType<'error'> {
  return { type: 'error', ts: Date.now(), phase: 'implementing', message: 'Something went wrong', ...overrides };
}

const DEFAULT_TOKEN_USAGE = {
  plannerInput: 100, plannerOutput: 50,
  implementerInput: 200, implementerOutput: 100,
  escalationInput: 0, escalationOutput: 0,
};

export function makeCostUpdate(overrides?: Partial<EventOfType<'cost_update'>>): EventOfType<'cost_update'> {
  return { type: 'cost_update', ts: Date.now(), phase: 'implementing', tokenUsage: DEFAULT_TOKEN_USAGE, ...overrides };
}

export function makeWorkflowCancelled(ts = Date.now()): EngineEvent {
  return { type: 'workflow_cancelled', ts, phase: 'implementing' };
}
