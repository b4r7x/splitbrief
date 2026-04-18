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

  it('updates currentTask and totalTasks on task-start', () => {
    const event = makeTaskStart({ index: 2, total: 5 });
    addEvent(event);
    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(5);
  });

  it('adds task to taskMap as in_progress on task-start', () => {
    const event = makeTaskStart({ taskId: taskId('T010'), title: 'New task' });
    addEvent(event);
    expect(tasksStore.get().taskMap.get('T010')).toEqual({ id: 'T010', title: 'New task', status: 'in_progress' });
  });

  it('updates taskMap status to done on task-complete', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
    addEvent(makeTaskComplete({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('done');
  });

  it('updates taskMap status to skipped on task-skipped', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
    addEvent(makeTaskSkipped({ taskId: taskId('T001') }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('skipped');
  });

  it('tracks task duration in taskCompletionTimes on task-complete', () => {
    addEvent(makeTaskComplete({ duration: 5000 }));
    addEvent(makeTaskComplete({ taskId: taskId('T002'), duration: 8000 }));
    expect(tasksStore.get().taskCompletionTimes).toEqual([5000, 8000]);
  });

  it('does not update taskMap for unknown taskId on task-complete', () => {
    const event = makeTaskComplete({ taskId: taskId('UNKNOWN') });
    addEvent(event);
    expect(tasksStore.get().taskMap.size).toBe(0);
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
