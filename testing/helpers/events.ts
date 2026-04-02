import type { TuiEvent } from '../../src/types.js';

type EventOfType<T extends TuiEvent['type']> = Extract<TuiEvent, { type: T }>;

export function makePlannerStatus(overrides?: Partial<EventOfType<'planner-status'>>): EventOfType<'planner-status'> {
  return { type: 'planner-status', ts: Date.now(), phase: 'implementing', status: 'running', ...overrides };
}

export function makePlannerText(overrides?: Partial<EventOfType<'planner-text'>>): EventOfType<'planner-text'> {
  return { type: 'planner-text', ts: Date.now(), text: 'Planning...', ...overrides };
}

export function makeTaskStart(overrides?: Partial<EventOfType<'task-start'>>): EventOfType<'task-start'> {
  return { type: 'task-start', ts: Date.now(), taskId: 'T001', title: 'Test task', index: 0, total: 3, file: 'src/test.ts', action: 'modify', ...overrides };
}

export function makeTaskComplete(overrides?: Partial<EventOfType<'task-complete'>>): EventOfType<'task-complete'> {
  return { type: 'task-complete', ts: Date.now(), taskId: 'T001', title: 'Test task', method: 'local', retries: 0, duration: 5000, ...overrides };
}

export function makeTaskSkipped(overrides?: Partial<EventOfType<'task-skipped'>>): EventOfType<'task-skipped'> {
  return { type: 'task-skipped', ts: Date.now(), taskId: 'T001', title: 'Test task', reason: 'dependency failed', ...overrides };
}

export function makeImplementerGenerate(overrides?: Partial<EventOfType<'implementer-generate'>>): EventOfType<'implementer-generate'> {
  return { type: 'implementer-generate', ts: Date.now(), status: 'done', model: 'qwen2.5-coder:7b', file: 'src/test.ts', linesAdded: 10, linesRemoved: 2, ...overrides };
}

export function makeValidate(overrides?: Partial<EventOfType<'validate'>>): EventOfType<'validate'> {
  return { type: 'validate', ts: Date.now(), status: 'done', passed: true, stages: { tsc: true, lint: true, test: true }, ...overrides };
}

export function makeRetry(overrides?: Partial<EventOfType<'retry'>>): EventOfType<'retry'> {
  return { type: 'retry', ts: Date.now(), taskId: 'T001', attempt: 1, maxRetries: 3, ...overrides };
}

export function makeEscalate(overrides?: Partial<EventOfType<'escalate'>>): EventOfType<'escalate'> {
  return { type: 'escalate', ts: Date.now(), tier: 1, ...overrides };
}

export function makeGitCommit(overrides?: Partial<EventOfType<'git-commit'>>): EventOfType<'git-commit'> {
  return { type: 'git-commit', ts: Date.now(), message: 'feat: implement test task', ...overrides };
}

export function makeErrorEvent(overrides?: Partial<EventOfType<'error'>>): EventOfType<'error'> {
  return { type: 'error', ts: Date.now(), message: 'Something went wrong', ...overrides };
}
