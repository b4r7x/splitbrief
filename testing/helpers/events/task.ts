import type { EngineEvent } from '../../../src/engine/events/types.js';
import { taskId } from '../../../src/core/schemas/task.js';

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

export function makeReviewFixInsertedEvents(announce = true): EngineEvent[] {
  const ts = 1_783_958_400_000;
  const titles = [
    'Add the book catalogue schema',
    'Implement book checkout',
    'Implement book returns',
    'Add overdue book reporting',
    'Wire the library dashboard',
    'Implement and test overdue book lookup',
    'Test overdue report boundaries',
  ];
  const tasks = titles.map((title, index) => ({
    id: taskId(`T${String(index + 1).padStart(3, '0')}`),
    title,
    index,
    file: `src/library/task-${index + 1}.ts`,
    action: 'modify' as const,
  }));
  const planned = (ordered: typeof tasks): EventOfType<'tasks_planned'> => ({
    type: 'tasks_planned',
    ts,
    phase: 'implementing',
    total: ordered.length,
    tasks: ordered.map((task, index) => ({ ...task, index })),
  });
  const events: EngineEvent[] = [planned(tasks.slice(0, 5))];
  for (const task of tasks.slice(0, 4)) {
    events.push(
      makeTaskStart({ ...task, taskId: task.id, ts: ts + events.length, total: 5 }),
      makeTaskComplete({ taskId: task.id, title: task.title, ts: ts + events.length + 1 }),
    );
  }
  if (announce)
    events.push(planned([...tasks.slice(0, 4), ...tasks.slice(5), ...tasks.slice(4, 5)]));
  events.push(
    {
      type: 'review_fix_started',
      ts: ts + 20,
      phase: 'implementing',
      cycle: 1,
      taskIds: [taskId('T006'), taskId('T007')],
    },
    makeTaskStart({
      taskId: taskId('T006'),
      title: 'Implement and test overdue book lookup',
      ts: ts + 21,
      index: 4,
      total: 7,
      file: 'src/library/task-6.ts',
      files: ['src/library/task-6.ts', 'src/library/task-6.test.ts'],
      tool: 'ollama',
      model: 'qwen2.5-coder:7b',
      implementerProfile: 'local',
    }),
  );
  return events;
}

type BriefBoundary = 'run-start' | 'between-briefs' | 'after-last-brief';

/** A build of two briefs, T001 and T002, stopped at a moment when no brief runs. */
export function makeBriefBoundaryEvents(boundary: BriefBoundary): EngineEvent[] {
  const ts = 1_783_958_400_000;
  const tasks = [taskId('T001'), taskId('T002')].map((id, index) => ({
    id,
    title: `Task ${index + 1}`,
    index,
    file: `src/task-${index + 1}.ts`,
    action: 'modify' as const,
  }));
  const settled = { 'run-start': 0, 'between-briefs': 1, 'after-last-brief': 2 }[boundary];
  return [
    { type: 'tasks_planned', ts, phase: 'implementing', total: tasks.length, tasks },
    ...tasks
      .slice(0, settled)
      .flatMap((task) => [
        makeTaskStart({ ...task, taskId: task.id, ts: ts + 10 * task.index + 1, total: 2 }),
        makeTaskComplete({ taskId: task.id, title: task.title, ts: ts + 10 * task.index + 2 }),
      ]),
  ];
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

export function makeBriefSettled(
  overrides?: Partial<EventOfType<'task_settled'>>,
): EventOfType<'task_settled'> {
  return {
    type: 'task_settled',
    ts: Date.now(),
    phase: 'implementing',
    taskId: taskId('T001'),
    method: 'local',

    retryCount: 0,
    ...overrides,
  };
}
