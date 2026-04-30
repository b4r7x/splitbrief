import { describe, it, expect, beforeEach } from 'vitest';
import { tasksStore, updateTaskMap } from './tasks.js';
import { addEvent, resetWorkflow } from './actions.js';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { WorkflowTask } from './tasks.js';
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

  it('marks completed tasks by completion method instead of treating every completion as done', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Failed task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T001'), method: 'failed' }));
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('failed');

    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Escalated task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T002'), method: 'escalated-full' }));
    expect(tasksStore.get().taskMap.get('T002')!.status).toBe('escalated');

    addEvent(makeTaskStart({ taskId: taskId('T003'), title: 'Tool task' }));
    addEvent(makeTaskComplete({ taskId: taskId('T003'), method: 'mcp-tool' }));
    expect(tasksStore.get().taskMap.get('T003')!.status).toBe('done');
  });

  it('updates task state from failure and escalation lifecycle events', () => {
    addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Escalating task' }));
    addEvent({ type: 'task_escalating', ts: Date.now(), phase: 'escalating', taskId: taskId('T001') });
    expect(tasksStore.get().taskMap.get('T001')!.status).toBe('escalated');

    addEvent(makeTaskStart({ taskId: taskId('T002'), title: 'Failed task' }));
    addEvent({ type: 'task_failed', ts: Date.now(), phase: 'implementing', taskId: taskId('T002') });
    expect(tasksStore.get().taskMap.get('T002')!.status).toBe('failed');

    addEvent(makeTaskStart({ taskId: taskId('T003'), title: 'Full fail task' }));
    addEvent({ type: 'task_full_fail', ts: Date.now(), phase: 'escalating', taskId: taskId('T003') });
    expect(tasksStore.get().taskMap.get('T003')!.status).toBe('failed');
  });
});

describe('updateTaskMap (pure)', () => {
  it('status unchanged returns original map', () => {
    const existing = new Map<string, WorkflowTask>([
      ['T003', { id: 'T003', title: 'Already done', status: 'done' }],
    ]);
    const next = updateTaskMap(existing, makeTaskComplete({ taskId: taskId('T003') }));
    expect(next).toBe(existing);
  });

  it('leaves unknown terminal task events out of the map', () => {
    const existing = new Map<string, WorkflowTask>();
    const event = {
      type: 'task_failed',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('UNKNOWN'),
    } satisfies EngineEvent;
    expect(updateTaskMap(existing, event)).toBe(existing);
  });
});
