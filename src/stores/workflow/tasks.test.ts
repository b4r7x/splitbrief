import { describe, it, expect, beforeEach } from 'vitest';
import {
  briefAfter,
  selectRunningBrief,
  selectTaskListView,
  taskRowLabel,
  taskTargetLabel,
  taskTargetParts,
  tasksStore,
} from './tasks.js';
import { addEvent } from './actions/event.js';
import { resetWorkflow } from './actions/reset.js';
import { taskId } from '../../core/schemas/task.js';
import {
  makeRetry,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeReviewFixInsertedEvents,
} from '#testing/helpers/events/task.js';
import { eventsStore } from './events.js';
import { tokensStore } from './tokens.js';
import type { EngineEvent } from '../../engine/events/types.js';

function makeTasksPlanned(count: number): EngineEvent {
  return {
    type: 'tasks_planned',
    ts: 1,
    phase: 'implementing',
    total: count,
    tasks: Array.from({ length: count }, (_value, index) => ({
      id: taskId(`T${String(index + 1).padStart(3, '0')}`),
      title: `Task ${index + 1}`,
      index,
      file: `src/file-${index + 1}.ts`,
      action: 'modify' as const,
    })),
  };
}

describe('tasksStore — via addEvent', () => {
  beforeEach(() => resetWorkflow());

  it('covers task-start → task-complete happy path end-to-end', () => {
    addEvent(makeTaskStart({ taskId: taskId('T010'), title: 'New task', index: 0, total: 5 }));
    expect(tasksStore.get().currentTask).toBe(1);
    expect(tasksStore.get().totalTasks).toBe(5);
    expect(tasksStore.get().taskMap.get('T010')).toEqual({
      id: 'T010',
      title: 'New task',
      status: 'in_progress',
      file: 'src/test.ts',
      action: 'modify',
    });

    addEvent(makeTaskComplete({ taskId: taskId('T010'), duration: 5000 }));
    expect(tasksStore.get().taskMap.get('T010')!.status).toBe('done');

    // task-complete for an unknown taskId does not add a new entry to taskMap.
    addEvent(makeTaskComplete({ taskId: taskId('T999'), duration: 8000 }));
    expect(tasksStore.get().taskMap.get('T999')).toBeUndefined();
    expect(tasksStore.get().taskMap.size).toBe(1);
  });

  it('covers task-start → task-skipped path end-to-end', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('in_progress');

    addEvent(makeTaskSkipped({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('skipped');
  });

  it('marks completed tasks by completion method instead of treating every completion as done', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Failed task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T001'), method: 'failed' }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('failed');

    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Escalated task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T002'), method: 'escalated-full' }));
    expect(tasksStore.get().taskMap.get('T002')!.status).toBe('escalated');

    addEvent(makeTaskStart({ taskId: taskId('T004'), title: 'Intermediate task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T004'), method: 'escalated-intermediate' }));
    expect(tasksStore.get().taskMap.get('T004')!.status).toBe('escalated');

    addEvent(makeTaskStart({ taskId: taskId('T005'), title: 'Hint task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T005'), method: 'escalated-hint' }));
    expect(tasksStore.get().taskMap.get('T005')!.status).toBe('escalated');

    addEvent(makeTaskStart({ taskId: taskId('T003'), title: 'Locally completed task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T003'), method: 'local' }));
    expect(tasksStore.get().taskMap.get('T003')!.status).toBe('done');
  });

  it('keeps the latest task route current across retries and completion', () => {
    addEvent(
      makeTaskStart({
        taskId: taskId('T001'),
        implementerProfile: 'stale-profile',
        tool: 'old-tool',
        model: 'old-model',
      }),
    );
    addEvent(
      makeTaskStart({
        taskId: taskId('T001'),
        implementerProfile: 'cheap-cloud',
        tool: 'codex',
        model: 'gpt-5.6',
      }),
    );

    expect(tasksStore.get().taskMap.get('T001')?.route).toEqual({
      profile: 'cheap-cloud',
      runner: 'codex',
      model: 'gpt-5.6',
    });

    // A retry changes only the attempt counter; the task map and its route are the same objects.
    const beforeRetry = tasksStore.get();
    addEvent(makeRetry({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap).toBe(beforeRetry.taskMap);
    expect(tasksStore.get().currentAttempt).toBe(2);

    addEvent(makeTaskComplete({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap.get('T001')?.route).toEqual({
      profile: 'cheap-cloud',
      runner: 'codex',
      model: 'gpt-5.6',
    });
  });

  it('returns failed or done tasks to pending on task_reset', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Failed task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T001'), method: 'failed' }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('failed');

    addEvent({
      type: 'task_reset',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('T001'),
    });
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('pending');
  });

  it('updates task state from escalation lifecycle events', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Escalating task' }));
    addEvent({
      type: 'task_escalating',
      ts: Date.now(),
      phase: 'escalating',
      taskId: taskId('T001'),
    });
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('in_progress');
    addEvent(makeTaskStart({ taskId: taskId('T003'), title: 'Full fail task' }));
    addEvent({
      type: 'task_full_fail',
      ts: Date.now(),
      phase: 'escalating',
      taskId: taskId('T003'),
    });
    expect(tasksStore.get().taskMap.get('T003')!.status).toBe('failed');
  });
});

describe('tasks_planned', () => {
  beforeEach(() => resetWorkflow());

  it('inserts every review fix before pending work and focuses by started id', () => {
    for (const event of makeReviewFixInsertedEvents()) addEvent(event);
    const state = tasksStore.get();
    expect(state.tasks.map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T004',
      'T006',
      'T007',
      'T005',
    ]);
    expect(state.currentTask).toBe(5);
    expect(selectRunningBrief(state, 'implementing')).toMatchObject({
      current: { id: 'T006' },
      next: { id: 'T007' },
    });
    expect(briefAfter(state, 'T006')?.id).toBe('T007');
    expect(selectTaskListView(state)).toMatchObject({ passed: 4, total: 7, unannounced: 0 });

    addEvent(makeTaskComplete({ taskId: taskId('T006') }));
    addEvent(makeTaskStart({ taskId: taskId('T007'), index: 5, total: 7 }));
    expect(tasksStore.get().currentTask).toBe(6);
    expect(selectRunningBrief(tasksStore.get(), 'implementing')).toMatchObject({
      current: { id: 'T007' },
      next: { id: 'T005' },
    });
  });

  it('ignores a deliberately wrong task_started index and focuses the announced id', () => {
    for (const event of makeReviewFixInsertedEvents()) addEvent(event);
    addEvent(makeTaskComplete({ taskId: taskId('T006') }));
    addEvent(makeTaskStart({ taskId: taskId('T007'), index: 99, total: 7 }));
    expect(tasksStore.get().currentTask).toBe(6);
    expect(selectRunningBrief(tasksStore.get(), 'implementing')).toMatchObject({
      current: { id: 'T007' },
      next: { id: 'T005' },
    });
  });

  it('republishing keeps statuses, routes, files, focus and tokens without adding transcript rows', () => {
    const events = makeReviewFixInsertedEvents();
    for (const event of events) addEvent(event);
    const before = tasksStore.get();
    const tokens = tokensStore.get();
    const log = eventsStore.get().events;
    const announcement = events.findLast((event) => event.type === 'tasks_planned');
    if (announcement === undefined) throw new Error('Missing inserted announcement');
    addEvent(announcement);
    addEvent(announcement);
    expect(tasksStore.get()).toEqual(before);
    expect(tokensStore.get()).toBe(tokens);
    expect(eventsStore.get().events).toBe(log);
    expect(tasksStore.get().taskMap.get('T006')).toMatchObject({
      status: 'in_progress',
      files: ['src/library/task-6.ts', 'src/library/task-6.test.ts'],
      route: { profile: 'local', runner: 'ollama', model: 'qwen2.5-coder:7b' },
    });
  });

  it('resolves focus after reordering and clears it when a split drops the focused parent', () => {
    addEvent(makeTasksPlanned(3));
    addEvent(makeTaskStart({ taskId: taskId('T001'), total: 3 }));
    const announcement = makeTasksPlanned(3);
    if (announcement.type !== 'tasks_planned') throw new Error('Expected announcement');
    addEvent({ ...announcement, tasks: [...announcement.tasks].reverse() });
    expect(tasksStore.get().currentTask).toBe(3);
    expect(selectRunningBrief(tasksStore.get(), 'implementing').current?.id).toBe('T001');
    addEvent({
      ...announcement,
      total: 2,
      tasks: announcement.tasks.filter((task) => task.id !== 'T001'),
    });
    expect(tasksStore.get().taskMap.has('T001')).toBe(false);
    expect(tasksStore.get().currentTask).toBe(0);
    expect(selectRunningBrief(tasksStore.get(), 'implementing').current).toBeNull();
  });

  it('task_reset moves focus to its id even when that task is already pending', () => {
    addEvent(makeTasksPlanned(3));
    addEvent(makeTaskStart({ taskId: taskId('T003'), total: 3 }));
    addEvent({ type: 'task_reset', ts: 2, phase: 'implementing', taskId: taskId('T001') });
    expect(tasksStore.get().currentTask).toBe(1);
    expect(selectRunningBrief(tasksStore.get(), 'implementing')).toMatchObject({
      current: { id: 'T001' },
      next: { id: 'T002' },
    });
  });

  it('old logs append an unannounced started id and focus its actual position', () => {
    for (const event of makeReviewFixInsertedEvents(false)) addEvent(event);
    expect(tasksStore.get().tasks.map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T004',
      'T005',
      'T006',
    ]);
    expect(tasksStore.get().currentTask).toBe(6);
    expect(selectRunningBrief(tasksStore.get(), 'implementing').current?.id).toBe('T006');
    expect(selectTaskListView(tasksStore.get())).toMatchObject({
      passed: 4,
      total: 7,
      unannounced: 1,
    });
  });

  it('lists the whole plan as pending before any task starts', () => {
    addEvent(makeTasksPlanned(4));

    const view = selectTaskListView(tasksStore.get());

    expect(view.items.map((task) => `${task.id}:${task.status}`)).toEqual([
      'T001:pending',
      'T002:pending',
      'T003:pending',
      'T004:pending',
    ]);
    expect(view.total).toBe(4);
    // Every task now has a title, so nothing is left to report as an unannounced remainder.
    expect(view.unannounced).toBe(0);
  });

  it('keeps the status a task already earned when the plan is republished', () => {
    addEvent(makeTasksPlanned(3));
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 3 }));
    addEvent(makeTaskComplete({ taskId: taskId('T001'), title: 'Task 1' }));
    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Task 2', index: 1, total: 3 }));

    // Resume and detached re-attach both replay the announcement.
    addEvent(makeTasksPlanned(3));

    expect(tasksStore.get().tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      'T001:done',
      'T002:in_progress',
      'T003:pending',
    ]);
  });

  it('keeps task state unchanged when a review fix cycle starts', () => {
    addEvent(makeTasksPlanned(10));
    for (let index = 0; index < 10; index += 1) {
      const id = taskId(`T${String(index + 1).padStart(3, '0')}`);
      addEvent(makeTaskStart({ taskId: id, title: `Task ${index + 1}`, index, total: 10 }));
      addEvent(makeTaskComplete({ taskId: id, title: `Task ${index + 1}` }));
    }

    const before = tasksStore.get();
    addEvent({
      type: 'review_fix_started',
      ts: Date.now(),
      phase: 'final-review',
      cycle: 1,
      taskIds: [taskId('T001'), taskId('T007'), taskId('T010')],
    });

    const view = selectTaskListView(tasksStore.get());
    expect(tasksStore.get().taskMap).toBe(before.taskMap);
    expect(view.passed).toBe(10);
    expect(view.total).toBe(10);
    expect(view.items.filter((task) => task.status === 'pending')).toEqual([]);
  });

  it('reconciles a republished plan as a snapshot', () => {
    addEvent(makeTasksPlanned(3));
    addEvent(
      makeTaskStart({
        taskId: taskId('T001'),
        title: 'Original task',
        index: 0,
        total: 3,
        implementerProfile: 'cheap-cloud',
        tool: 'codex',
        model: 'gpt-5.6',
      }),
    );
    addEvent(makeTaskComplete({ taskId: taskId('T001'), title: 'Original task' }));

    addEvent({
      type: 'tasks_planned',
      ts: 2,
      phase: 'implementing',
      total: 3,
      tasks: [
        {
          id: taskId('T003'),
          title: 'Revised third task',
          index: 0,
          file: 'src/revised-third.ts',
          action: 'modify',
        },
        {
          id: taskId('T001'),
          title: 'Completed task moved',
          index: 1,
          file: 'src/new-target.ts',
          action: 'create',
        },
        {
          id: taskId('T004'),
          title: 'New fourth task',
          index: 2,
          file: 'src/fourth.ts',
          action: 'modify',
        },
      ],
    });

    expect(tasksStore.get().tasks).toEqual([
      {
        id: 'T003',
        title: 'Revised third task',
        status: 'pending',
        file: 'src/revised-third.ts',
        action: 'modify',
      },
      {
        id: 'T001',
        title: 'Completed task moved',
        status: 'done',
        file: 'src/new-target.ts',
        action: 'create',
        route: {
          profile: 'cheap-cloud',
          runner: 'codex',
          model: 'gpt-5.6',
        },
      },
      {
        id: 'T004',
        title: 'New fourth task',
        status: 'pending',
        file: 'src/fourth.ts',
        action: 'modify',
      },
    ]);
    expect(tasksStore.get().taskMap.has('T002')).toBe(false);
    expect(tasksStore.get().totalTasks).toBe(3);
  });

  it('seeds the file and action a row needs, so neither can reach the screen as "undefined"', () => {
    addEvent(makeTasksPlanned(2));

    const [first] = tasksStore.get().tasks;
    expect(first?.file).toBe('src/file-1.ts');
    expect(first?.action).toBe('modify');
    expect(taskTargetLabel(first ?? { id: '', title: '', status: 'pending' })).toBe(
      'src/file-1.ts (modify)',
    );

    // task_started carries both too, so starting a seeded task must not blank them.
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 2 }));
    const started = tasksStore.get().taskMap.get('T001');
    expect(started?.file).toBe('src/test.ts');
    expect(started?.action).toBe('modify');
  });

  it('never renders a missing target as the literal string undefined', () => {
    // The resume path rebuilds tasks from persisted state that carries neither field.
    expect(taskTargetLabel({ id: 'T001', title: 'Resumed', status: 'pending' })).toBe('');
    expect(taskTargetLabel({ id: 'T001', title: 'Resumed', status: 'pending', file: 'a.ts' })).toBe(
      'a.ts',
    );
  });

  it('taskTargetLabel counts the rest of a slice in its own token, with the unit', () => {
    expect(
      taskTargetLabel({
        id: 'T001',
        title: 'Slice',
        status: 'in_progress',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        action: 'modify',
      }),
    ).toBe('src/a.ts (modify) · +2 files');

    expect(
      taskTargetLabel({
        id: 'T001',
        title: 'Slice',
        status: 'in_progress',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts'],
        action: 'modify',
      }),
    ).toBe('src/a.ts (modify) · +1 file');
  });

  it('returns the target path and annotations as separate parts', () => {
    expect(
      taskTargetParts({
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        action: 'modify',
      }),
    ).toEqual({ path: 'src/a.ts', note: '(modify)', extraFiles: '+2 files' });
    expect(taskTargetParts({ file: 'src/a.ts', files: ['src/a.ts', 'src/b.ts'] })).toEqual({
      path: 'src/a.ts',
      note: '',
      extraFiles: '+1 file',
    });
    expect(taskTargetParts({})).toEqual({
      path: '',
      note: '',
      extraFiles: '',
    });
  });

  it('keeps the extra file count separate when the target has no action', () => {
    expect(
      taskTargetLabel({
        id: 'T001',
        title: 'Slice',
        status: 'pending',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/b.ts'],
      }),
    ).toBe('src/a.ts · +1 file');
  });

  it('agrees with the total task_started carries, so the header cannot flicker', () => {
    addEvent(makeTasksPlanned(3));
    expect(tasksStore.get().totalTasks).toBe(3);

    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 3 }));
    expect(tasksStore.get().totalTasks).toBe(3);
    expect(selectTaskListView(tasksStore.get()).total).toBe(3);
  });
});

describe('taskRowLabel', () => {
  const task = {
    id: 'T006',
    title: 'Look up books',
    status: 'pending' as const,
    file: 'src/books.ts',
    action: 'modify' as const,
  };

  it.each([
    [45, 'T006 Look up books · src/books.ts (modify)'],
    [42, 'T006 Look up books · src/books.ts (modify)'],
    [41, 'T006 Look up books'],
    [18, 'T006 Look up books'],
    [17, 'T006 Look up boo…'],
    [13, 'T006 Look up…'],
    [6, 'T006 …'],
    [5, 'T006'],
    [4, 'T006'],
    [2, 'T006'],
  ])('fits the label at %i cells without splitting its target or id', (cells, expected) => {
    expect(taskRowLabel(task, cells)).toBe(expected);
  });

  it('uses terminal cells when it truncates a wide title', () => {
    expect(taskRowLabel({ ...task, title: '図書一覧' }, 11)).toBe('T006 図書…');
  });

  it('sanitizes the title and target before measuring them', () => {
    expect(taskRowLabel({ ...task, title: '\u001b[31mBooks\u001b[0m', file: 'a.ts' }, 80)).toBe(
      'T006 Books · a.ts (modify)',
    );
    expect(taskRowLabel({ id: task.id, title: '', status: task.status }, 4)).toBe('T006');
  });
});

describe('selectTaskListView', () => {
  beforeEach(() => resetWorkflow());

  it('counts the tasks the plan announced, not just the ones already started', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'First', index: 0, total: 5 }));
    addEvent(makeTaskComplete({ taskId: taskId('T001'), title: 'First' }));
    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Second', index: 1, total: 5 }));

    const view = selectTaskListView(tasksStore.get());

    expect(view.total).toBe(5);
    expect(view.passed).toBe(1);
    expect(view.unannounced).toBe(3);
    expect(view.items.map((task) => task.id)).toEqual(['T001', 'T002']);
  });

  it('escalated not settled: passed excludes escalated', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'First', index: 0, total: 3 }));
    addEvent(
      makeTaskComplete({ taskId: taskId('T001'), title: 'First', method: 'escalated-full' }),
    );
    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Second', index: 1, total: 3 }));

    const view = selectTaskListView(tasksStore.get());

    expect(view.passed).toBe(0);
    expect(view.escalated).toBe(1);
    expect(view.total).toBe(3);
  });

  it('never reports a total below the tasks it already holds', () => {
    const view = selectTaskListView({
      currentTask: 0,
      currentAttempt: 1,
      attemptAllowance: 8,
      totalTasks: 0,
      taskMap: new Map(),
      tasks: [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'in_progress' },
      ],
    });

    expect(view.total).toBe(2);
    expect(view.unannounced).toBe(0);
  });
});
