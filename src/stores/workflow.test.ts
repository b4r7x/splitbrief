import { describe, it, expect, beforeEach } from 'vitest';
import { workflowStore, MAX_EVENTS } from './workflow.js';
import {
  makePlannerStatus,
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeRetry,
} from '#testing/helpers/events.js';

describe('workflowStore', () => {
  beforeEach(() => workflowStore.reset());

  describe('addEvent', () => {
    it('appends event to events array', () => {
      const event = makePlannerText();
      workflowStore.addEvent(event);
      const s = workflowStore.get();
      expect(s.events).toHaveLength(1);
      expect(s.events[0]).toBe(event);
    });

    it('updates phase when planner-status event received', () => {
      const event = makePlannerStatus({ phase: 'specifying' });
      workflowStore.addEvent(event);
      expect(workflowStore.get().phase).toBe('specifying');
    });

    it('updates currentTask and totalTasks on task-start', () => {
      const event = makeTaskStart({ index: 2, total: 5 });
      workflowStore.addEvent(event);
      expect(workflowStore.get().currentTask).toBe(3);
      expect(workflowStore.get().totalTasks).toBe(5);
    });

    it('adds task to taskMap as in_progress on task-start', () => {
      const event = makeTaskStart({ taskId: 'T010', title: 'New task' });
      workflowStore.addEvent(event);
      expect(workflowStore.get().taskMap.get('T010')).toEqual({ id: 'T010', title: 'New task', status: 'in_progress' });
    });

    it('increments localCount on task-complete with method=local', () => {
      workflowStore.reset({ localCount: 1 });
      const event = makeTaskComplete({ method: 'local' });
      workflowStore.addEvent(event);
      expect(workflowStore.get().localCount).toBe(2);
    });

    it('increments escalatedCount on task-complete with method=escalated', () => {
      const event = makeTaskComplete({ method: 'escalated' });
      workflowStore.addEvent(event);
      expect(workflowStore.get().escalatedCount).toBe(1);
    });

    it('updates taskMap status to done on task-complete', () => {
      workflowStore.addEvent(makeTaskStart({ taskId: 'T001', title: 'Test' }));
      workflowStore.addEvent(makeTaskComplete({ taskId: 'T001' }));
      expect(workflowStore.get().taskMap.get('T001')!.status).toBe('done');
    });

    it('updates taskMap status to skipped on task-skipped', () => {
      workflowStore.addEvent(makeTaskStart({ taskId: 'T001', title: 'Test' }));
      workflowStore.addEvent(makeTaskSkipped({ taskId: 'T001' }));
      expect(workflowStore.get().taskMap.get('T001')!.status).toBe('skipped');
    });

    it('does not update taskMap for unknown taskId on task-complete', () => {
      const event = makeTaskComplete({ taskId: 'UNKNOWN' });
      workflowStore.addEvent(event);
      expect(workflowStore.get().taskMap.size).toBe(0);
    });

    it('trims events to MAX_EVENTS when exceeded', () => {
      const events = Array.from({ length: MAX_EVENTS }, (_, i) => makePlannerText({ text: `msg-${i}` }));
      for (const e of events) workflowStore.addEvent(e);
      workflowStore.addEvent(makePlannerText({ text: 'overflow' }));
      const s = workflowStore.get();
      expect(s.events).toHaveLength(MAX_EVENTS);
      expect((s.events[s.events.length - 1] as { text: string }).text).toBe('overflow');
      expect((s.events[0] as { text: string }).text).toBe('msg-1');
    });

    it('preserves other state fields on generic events', () => {
      workflowStore.reset({ phase: 'implementing', localCount: 3, escalatedCount: 1 });
      workflowStore.addEvent(makeRetry());
      const s = workflowStore.get();
      expect(s.phase).toBe('implementing');
      expect(s.localCount).toBe(3);
      expect(s.escalatedCount).toBe(1);
    });
  });

  describe('setReviewFile', () => {
    it('sets reviewFilePath', () => {
      workflowStore.setReviewFile('/tmp/spec.md');
      expect(workflowStore.get().reviewFilePath).toBe('/tmp/spec.md');
    });

    it('clears reviewFilePath when null', () => {
      workflowStore.setReviewFile('/tmp/spec.md');
      workflowStore.setReviewFile(null);
      expect(workflowStore.get().reviewFilePath).toBeNull();
    });
  });
});
