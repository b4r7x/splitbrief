import { describe, it, expect, beforeEach } from 'vitest';
import { selectTaskListView, taskTargetLabel, tasksStore } from './tasks.js';
import { addEvent } from './actions/event.js';
import { resetWorkflow } from './actions/reset.js';
import { taskId } from '../../core/schemas/task.js';
import {
  makeRetry,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
} from '#testing/helpers/events/task.js';
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
    addEvent(makeTaskStart({ taskId: taskId('T010'), title: 'New task', index: 2, total: 5 }));
    expect(tasksStore.get().currentTask).toBe(3);
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
    expect(tasksStore.get().taskCompletionTimes).toEqual([5000]);

    // task-complete for an unknown taskId does not add a new entry to taskMap,
    // but its duration is still tracked (duration is event-sourced, not taskMap-sourced).
    addEvent(makeTaskComplete({ taskId: taskId('T999'), duration: 8000 }));
    expect(tasksStore.get().taskMap.get('T999')).toBeUndefined();
    expect(tasksStore.get().taskMap.size).toBe(1);
    expect(tasksStore.get().taskCompletionTimes).toEqual([5000, 8000]);
  });

  it('covers task-start → task-skipped path end-to-end', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('in_progress');

    addEvent(makeTaskSkipped({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('skipped');
    expect(tasksStore.get().taskCompletionTimes).toEqual([]);
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

    const beforeRetry = tasksStore.get();
    addEvent(makeRetry({ taskId: taskId('T001') }));
    expect(tasksStore.get()).toBe(beforeRetry);

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

  it('agrees with the total task_started carries, so the header cannot flicker', () => {
    addEvent(makeTasksPlanned(3));
    expect(tasksStore.get().totalTasks).toBe(3);

    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Task 1', index: 0, total: 3 }));
    expect(tasksStore.get().totalTasks).toBe(3);
    expect(selectTaskListView(tasksStore.get()).total).toBe(3);
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
    expect(view.settled).toBe(1);
    expect(view.unannounced).toBe(3);
    expect(view.items.map((task) => task.id)).toEqual(['T001', 'T002']);
  });

  it('counts escalated tasks as settled and leaves running ones out', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'First', index: 0, total: 3 }));
    addEvent(
      makeTaskComplete({ taskId: taskId('T001'), title: 'First', method: 'escalated-full' }),
    );
    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Second', index: 1, total: 3 }));

    const view = selectTaskListView(tasksStore.get());

    expect(view.settled).toBe(1);
    expect(view.total).toBe(3);
  });

  it('never reports a total below the tasks it already holds', () => {
    const view = selectTaskListView({
      currentTask: 0,
      totalTasks: 0,
      taskCompletionTimes: [],
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
