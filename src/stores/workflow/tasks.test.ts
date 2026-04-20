import { describe, it, expect, beforeEach } from 'vitest';
import { tasksStore, updateTaskMap } from './tasks.js';
import { addEvent, resetWorkflow } from './actions.js';
import { taskId } from '../../core/schemas/task.js';
import type { SidebarTask } from '../../features/workflow/components/sidebar.js';
import {
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
} from '#testing/helpers/events.js';

describe('tasksStore — via addEvent', () => {
  beforeEach(() => resetWorkflow());

  it('covers task-start → task-complete happy path end-to-end', () => {
    // task-start updates currentTask/totalTasks and registers task as in_progress.
    addEvent(makeTaskStart({ taskId: taskId('T010'), title: 'New task', index: 2, total: 5 }));
    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(5);
    expect(tasksStore.get().taskMap.get('T010')).toEqual({
      id: 'T010',
      title: 'New task',
      status: 'in_progress',
    });

    // task-complete for the known task flips status to done and records its duration.
    addEvent(makeTaskComplete({ taskId: taskId('T010'), duration: 5000 }));
    expect(tasksStore.get().taskMap.get('T010')!.status).toBe('done');
    expect(tasksStore.get().taskCompletionTimes).toEqual([5000]);

    // task-complete for an unknown taskId does not add a new entry to taskMap,
    // but its duration is still tracked (duration is event-sourced, not taskMap-sourced).
    addEvent(makeTaskComplete({ taskId: taskId('UNKNOWN'), duration: 8000 }));
    expect(tasksStore.get().taskMap.get('UNKNOWN')).toBeUndefined();
    expect(tasksStore.get().taskMap.size).toBe(1);
    expect(tasksStore.get().taskCompletionTimes).toEqual([5000, 8000]);
  });

  it('covers task-start → task-skipped path end-to-end', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('in_progress');

    addEvent(makeTaskSkipped({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('skipped');
    // skipped does not contribute a completion time.
    expect(tasksStore.get().taskCompletionTimes).toEqual([]);
  });
});

describe('updateTaskMap (pure)', () => {
  it('status unchanged returns original map', () => {
    const existing = new Map<string, SidebarTask>([
      ['T003', { id: 'T003', title: 'Already done', status: 'done' }],
    ]);
    const next = updateTaskMap(existing, makeTaskComplete({ taskId: taskId('T003') }));
    expect(next).toBe(existing);
  });
});
