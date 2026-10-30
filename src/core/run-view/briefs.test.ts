import { describe, it, expect, beforeEach } from 'vitest';
import {
  briefAfter,
  EMPTY_BRIEFS,
  reduceBriefs,
  selectRunningBrief,
  selectSeatChangePoint,
  selectTaskListView,
  type RunBriefs,
} from './briefs.js';
import { taskTargetLabel } from './brief-labels.js';
import { taskId, type CheckResult } from '../schemas/task.js';
import {
  makeRetry,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeReviewFixInsertedEvents,
} from '#testing/helpers/events/task.js';
import type { EngineEvent } from '../../engine/events/types.js';

let briefs: RunBriefs = EMPTY_BRIEFS;

function apply(event: EngineEvent): void {
  briefs = reduceBriefs(briefs, event);
}

function checksRun(id: string, results: CheckResult[]): EngineEvent {
  return { type: 'checks_run', ts: 1, phase: 'validating-task', taskId: taskId(id), results };
}

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

describe('reduceBriefs', () => {
  beforeEach(() => {
    briefs = EMPTY_BRIEFS;
  });

  it('covers task-start → task-complete happy path end-to-end', () => {
    apply(makeTaskStart({ taskId: taskId('T010'), title: 'New task', index: 0, total: 5 }));
    expect(briefs.currentTask).toBe(1);
    expect(briefs.totalTasks).toBe(5);
    expect(briefs.taskMap.get('T010')).toEqual({
      id: 'T010',
      title: 'New task',
      status: 'in_progress',
      file: 'src/test.ts',
      action: 'modify',
    });

    apply(makeTaskComplete({ taskId: taskId('T010'), duration: 5000 }));
    expect(briefs.taskMap.get('T010')!.status).toBe('done');

    // task-complete for an unknown taskId does not add a new entry to taskMap.
    apply(makeTaskComplete({ taskId: taskId('T999'), duration: 8000 }));
    expect(briefs.taskMap.get('T999')).toBeUndefined();
    expect(briefs.taskMap.size).toBe(1);
  });

  it('covers task-start → task-skipped path end-to-end', () => {
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
    expect(briefs.taskMap.get('T001')!.status).toBe('in_progress');

    apply(makeTaskSkipped({ taskId: taskId('T001') }));
    expect(briefs.taskMap.get('T001')!.status).toBe('skipped');
  });

  it('marks completed tasks by completion method instead of treating every completion as done', () => {
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Failed task' }));
    apply(makeTaskComplete({ taskId: taskId('T001'), method: 'failed' }));
    expect(briefs.taskMap.get('T001')!.status).toBe('failed');

    apply(makeTaskStart({ taskId: taskId('T002'), title: 'Escalated task' }));
    apply(makeTaskComplete({ taskId: taskId('T002'), method: 'escalated-full' }));
    expect(briefs.taskMap.get('T002')!.status).toBe('escalated');

    apply(makeTaskStart({ taskId: taskId('T004'), title: 'Intermediate task' }));
    apply(makeTaskComplete({ taskId: taskId('T004'), method: 'escalated-intermediate' }));
    expect(briefs.taskMap.get('T004')!.status).toBe('escalated');

    apply(makeTaskStart({ taskId: taskId('T005'), title: 'Hint task' }));
    apply(makeTaskComplete({ taskId: taskId('T005'), method: 'escalated-hint' }));
    expect(briefs.taskMap.get('T005')!.status).toBe('escalated');

    apply(makeTaskStart({ taskId: taskId('T003'), title: 'Locally completed task' }));
    apply(makeTaskComplete({ taskId: taskId('T003'), method: 'local' }));
    expect(briefs.taskMap.get('T003')!.status).toBe('done');
  });

  it('keeps the latest task route current across retries and completion', () => {
    apply(
      makeTaskStart({
        taskId: taskId('T001'),
        implementerProfile: 'stale-profile',
        tool: 'old-tool',
        model: 'old-model',
      }),
    );
    apply(
      makeTaskStart({
        taskId: taskId('T001'),
        implementerProfile: 'cheap-cloud',
        tool: 'codex',
        model: 'gpt-5.6',
      }),
    );

    expect(briefs.taskMap.get('T001')?.route).toEqual({
      profile: 'cheap-cloud',
      runner: 'codex',
      model: 'gpt-5.6',
    });

    // A retry changes only the attempt counter; the task map and its route are the same objects.
    const beforeRetry = briefs;
    apply(makeRetry({ taskId: taskId('T001') }));
    expect(briefs.taskMap).toBe(beforeRetry.taskMap);
    expect(briefs.currentAttempt).toBe(2);

    apply(makeTaskComplete({ taskId: taskId('T001') }));
    expect(briefs.taskMap.get('T001')?.route).toEqual({
      profile: 'cheap-cloud',
      runner: 'codex',
      model: 'gpt-5.6',
    });
  });

  it('returns failed or done tasks to pending on task_reset', () => {
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Failed task' }));
    apply(makeTaskComplete({ taskId: taskId('T001'), method: 'failed' }));
    expect(briefs.taskMap.get('T001')!.status).toBe('failed');

    apply({
      type: 'task_reset',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('T001'),
    });
    expect(briefs.taskMap.get('T001')!.status).toBe('pending');
  });

  it('updates task state from escalation lifecycle events', () => {
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Escalating task' }));
    apply({
      type: 'task_escalating',
      ts: Date.now(),
      phase: 'escalating',
      taskId: taskId('T001'),
    });
    expect(briefs.taskMap.get('T001')!.status).toBe('in_progress');
    apply(makeTaskStart({ taskId: taskId('T003'), title: 'Full fail task' }));
    apply({
      type: 'task_full_fail',
      ts: Date.now(),
      phase: 'escalating',
      taskId: taskId('T003'),
    });
    expect(briefs.taskMap.get('T003')!.status).toBe('failed');
  });
});

describe('tasks_planned', () => {
  beforeEach(() => {
    briefs = EMPTY_BRIEFS;
  });

  it('inserts every review fix before pending work and focuses by started id', () => {
    for (const event of makeReviewFixInsertedEvents()) apply(event);
    const state = briefs;
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

    apply(makeTaskComplete({ taskId: taskId('T006') }));
    apply(makeTaskStart({ taskId: taskId('T007'), index: 5, total: 7 }));
    expect(briefs.currentTask).toBe(6);
    expect(selectRunningBrief(briefs, 'implementing')).toMatchObject({
      current: { id: 'T007' },
      next: { id: 'T005' },
    });
  });

  it('ignores a deliberately wrong task_started index and focuses the announced id', () => {
    for (const event of makeReviewFixInsertedEvents()) apply(event);
    apply(makeTaskComplete({ taskId: taskId('T006') }));
    apply(makeTaskStart({ taskId: taskId('T007'), index: 99, total: 7 }));
    expect(briefs.currentTask).toBe(6);
    expect(selectRunningBrief(briefs, 'implementing')).toMatchObject({
      current: { id: 'T007' },
      next: { id: 'T005' },
    });
  });

  it('resolves focus after reordering and clears it when a split drops the focused parent', () => {
    apply(makeTasksPlanned(3));
    apply(makeTaskStart({ taskId: taskId('T001'), total: 3 }));
    const announcement = makeTasksPlanned(3);
    if (announcement.type !== 'tasks_planned') throw new Error('Expected announcement');
    apply({ ...announcement, tasks: [...announcement.tasks].reverse() });
    expect(briefs.currentTask).toBe(3);
    expect(selectRunningBrief(briefs, 'implementing').current?.id).toBe('T001');
    apply({
      ...announcement,
      total: 2,
      tasks: announcement.tasks.filter((task) => task.id !== 'T001'),
    });
    expect(briefs.taskMap.has('T001')).toBe(false);
    expect(briefs.currentTask).toBe(0);
    expect(selectRunningBrief(briefs, 'implementing').current).toBeNull();
  });

  it('task_reset moves focus to its id even when that task is already pending', () => {
    apply(makeTasksPlanned(3));
    apply(makeTaskStart({ taskId: taskId('T003'), total: 3 }));
    apply({ type: 'task_reset', ts: 2, phase: 'implementing', taskId: taskId('T001') });
    expect(briefs.currentTask).toBe(1);
    expect(selectRunningBrief(briefs, 'implementing')).toMatchObject({
      current: { id: 'T001' },
      next: { id: 'T002' },
    });
  });

  it('old logs append an unannounced started id and focus its actual position', () => {
    for (const event of makeReviewFixInsertedEvents(false)) apply(event);
    expect(briefs.tasks.map((task) => task.id)).toEqual([
      'T001',
      'T002',
      'T003',
      'T004',
      'T005',
      'T006',
    ]);
    expect(briefs.currentTask).toBe(6);
    expect(selectRunningBrief(briefs, 'implementing').current?.id).toBe('T006');
    expect(selectTaskListView(briefs)).toMatchObject({
      passed: 4,
      total: 7,
      unannounced: 1,
    });
  });

  it('lists the whole plan as pending before any task starts', () => {
    apply(makeTasksPlanned(4));

    const view = selectTaskListView(briefs);

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
    apply(makeTasksPlanned(3));
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 3 }));
    apply(makeTaskComplete({ taskId: taskId('T001'), title: 'Task 1' }));
    apply(makeTaskStart({ taskId: taskId('T002'), title: 'Task 2', index: 1, total: 3 }));

    // Resume and detached re-attach both replay the announcement.
    apply(makeTasksPlanned(3));

    expect(briefs.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
      'T001:done',
      'T002:in_progress',
      'T003:pending',
    ]);
  });

  it('keeps task state unchanged when a review fix cycle starts', () => {
    apply(makeTasksPlanned(10));
    for (let index = 0; index < 10; index += 1) {
      const id = taskId(`T${String(index + 1).padStart(3, '0')}`);
      apply(makeTaskStart({ taskId: id, title: `Task ${index + 1}`, index, total: 10 }));
      apply(makeTaskComplete({ taskId: id, title: `Task ${index + 1}` }));
    }

    const before = briefs;
    apply({
      type: 'review_fix_started',
      ts: Date.now(),
      phase: 'final-review',
      cycle: 1,
      taskIds: [taskId('T001'), taskId('T007'), taskId('T010')],
    });

    const view = selectTaskListView(briefs);
    expect(briefs.taskMap).toBe(before.taskMap);
    expect(view.passed).toBe(10);
    expect(view.total).toBe(10);
    expect(view.items.filter((task) => task.status === 'pending')).toEqual([]);
  });

  it('reconciles a republished plan as a snapshot', () => {
    apply(makeTasksPlanned(3));
    apply(
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
    apply(makeTaskComplete({ taskId: taskId('T001'), title: 'Original task' }));

    apply({
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

    expect(briefs.tasks).toEqual([
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
    expect(briefs.taskMap.has('T002')).toBe(false);
    expect(briefs.totalTasks).toBe(3);
  });

  it('seeds the file and action a row needs, so neither can reach the screen as "undefined"', () => {
    apply(makeTasksPlanned(2));

    const [first] = briefs.tasks;
    expect(first?.file).toBe('src/file-1.ts');
    expect(first?.action).toBe('modify');
    expect(taskTargetLabel(first ?? { id: '', title: '', status: 'pending' })).toBe(
      'src/file-1.ts (modify)',
    );

    // task_started carries both too, so starting a seeded task must not blank them.
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 2 }));
    const started = briefs.taskMap.get('T001');
    expect(started?.file).toBe('src/test.ts');
    expect(started?.action).toBe('modify');
  });

  it('agrees with the total task_started carries, so the header cannot flicker', () => {
    apply(makeTasksPlanned(3));
    expect(briefs.totalTasks).toBe(3);

    apply(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 3 }));
    expect(briefs.totalTasks).toBe(3);
    expect(selectTaskListView(briefs).total).toBe(3);
  });
});

describe('selectTaskListView', () => {
  beforeEach(() => {
    briefs = EMPTY_BRIEFS;
  });

  it('counts the tasks the plan announced, not just the ones already started', () => {
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'First', index: 0, total: 5 }));
    apply(makeTaskComplete({ taskId: taskId('T001'), title: 'First' }));
    apply(makeTaskStart({ taskId: taskId('T002'), title: 'Second', index: 1, total: 5 }));

    const view = selectTaskListView(briefs);

    expect(view.total).toBe(5);
    expect(view.passed).toBe(1);
    expect(view.unannounced).toBe(3);
    expect(view.items.map((task) => task.id)).toEqual(['T001', 'T002']);
  });

  it('escalated not settled: passed excludes escalated', () => {
    apply(makeTaskStart({ taskId: taskId('T001'), title: 'First', index: 0, total: 3 }));
    apply(makeTaskComplete({ taskId: taskId('T001'), title: 'First', method: 'escalated-full' }));
    apply(makeTaskStart({ taskId: taskId('T002'), title: 'Second', index: 1, total: 3 }));

    const view = selectTaskListView(briefs);

    expect(view.passed).toBe(0);
    expect(view.escalated).toBe(1);
    expect(view.total).toBe(3);
  });

  it('never reports a total below the tasks it already holds', () => {
    const view = selectTaskListView({
      totalTasks: 0,
      tasks: [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'in_progress' },
      ],
    });

    expect(view.total).toBe(2);
    expect(view.unannounced).toBe(0);
  });
});

describe('selectSeatChangePoint', () => {
  const focus = (first: 'pending' | 'in_progress' | 'done' | 'escalated') => ({
    tasks: [
      { id: 'T001', title: 'first', status: first },
      { id: 'T002', title: 'second', status: 'pending' as const },
    ],
    currentTask: 1,
  });

  it('waits on the running brief', () => {
    expect(selectSeatChangePoint(focus('in_progress'), 'implementing')).toEqual({
      after: 'brief',
      taskId: 'T001',
    });
  });

  it('waits on the brief the run finished and has not handed on from', () => {
    expect(selectSeatChangePoint(focus('escalated'), 'implementing')).toEqual({
      after: 'brief',
      taskId: 'T001',
    });
  });

  it('waits on the next brief while the plan is made, planned briefs or not', () => {
    expect(selectSeatChangePoint(EMPTY_BRIEFS, 'planning')).toEqual({ after: 'next-brief' });
    expect(
      selectSeatChangePoint({ ...focus('pending'), currentTask: 0 }, 'reviewing-plan'),
    ).toEqual({
      after: 'next-brief',
    });
  });

  it('waits on a fix brief or the next run in the final review, past the last finished brief', () => {
    expect(selectSeatChangePoint(focus('done'), 'final-review')).toEqual({
      after: 'fix-brief-or-next-run',
    });
  });
});

describe('reduceBriefs — checks and the completed count', () => {
  it('keeps the latest checks of each brief', () => {
    let briefs = reduceBriefs(EMPTY_BRIEFS, checksRun('T001', [{ id: 'K1', status: 'fail' }]));
    briefs = reduceBriefs(briefs, checksRun('T002', [{ id: 'K1', status: 'pass' }]));
    briefs = reduceBriefs(briefs, checksRun('T001', [{ id: 'K1', status: 'pass' }]));
    expect(briefs.checks.get('T001')).toEqual([{ id: 'K1', status: 'pass' }]);
    expect(briefs.checks.get('T002')).toEqual([{ id: 'K1', status: 'pass' }]);
  });

  it('takes the completed count the last workflow_complete carries, and none from an older log', () => {
    const complete = (completedTasks?: number): EngineEvent => ({
      type: 'workflow_complete',
      ts: 1,
      phase: 'complete',
      ...(completedTasks !== undefined && { completedTasks }),
    });
    const counted = reduceBriefs(EMPTY_BRIEFS, complete(3));
    expect(counted.completedTasks).toBe(3);
    expect(reduceBriefs(counted, complete(3))).toBe(counted);
    expect(reduceBriefs(counted, complete()).completedTasks).toBeNull();
  });
});
