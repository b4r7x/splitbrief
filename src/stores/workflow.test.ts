import { describe, it, expect, beforeEach } from 'vitest';
import { workflowStore } from './workflow.js';
import { MAX_EVENTS } from './workflow-reducers.js';
import { taskId } from '../core/types/workflow.js';
import {
  makePlannerStatus,
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeRetry,
  makeCostUpdate,
  makeValidate,
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
      const event = makeTaskStart({ taskId: taskId('T010'), title: 'New task' });
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
      const event = makeTaskComplete({ method: 'escalated-hint' });
      workflowStore.addEvent(event);
      expect(workflowStore.get().escalatedCount).toBe(1);
    });

    it('updates taskMap status to done on task-complete', () => {
      workflowStore.addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
      workflowStore.addEvent(makeTaskComplete({ taskId: taskId('T001') }));
      expect(workflowStore.get().taskMap.get('T001')!.status).toBe('done');
    });

    it('updates taskMap status to skipped on task-skipped', () => {
      workflowStore.addEvent(makeTaskStart({ taskId: taskId('T001'), title: 'Test' }));
      workflowStore.addEvent(makeTaskSkipped({ taskId: taskId('T001') }));
      expect(workflowStore.get().taskMap.get('T001')!.status).toBe('skipped');
    });

    it('does not update taskMap for unknown taskId on task-complete', () => {
      const event = makeTaskComplete({ taskId: taskId('UNKNOWN') });
      workflowStore.addEvent(event);
      expect(workflowStore.get().taskMap.size).toBe(0);
    });

    it('trims events to MAX_EVENTS when exceeded', () => {
      const events = Array.from({ length: MAX_EVENTS }, (_, i) => makeRetry({ taskId: taskId(`T${i}`) }));
      for (const e of events) workflowStore.addEvent(e);
      workflowStore.addEvent(makeRetry({ taskId: taskId('overflow') }));
      const s = workflowStore.get();
      expect(s.events).toHaveLength(MAX_EVENTS);
      expect((s.events[s.events.length - 1] as { taskId: string }).taskId).toBe('overflow');
      expect((s.events[0] as { taskId: string }).taskId).toBe('T1');
    });

    it('coalesces consecutive planner-text events', () => {
      workflowStore.addEvent(makePlannerText({ text: 'hello ' }));
      workflowStore.addEvent(makePlannerText({ text: 'world' }));
      const s = workflowStore.get();
      expect(s.events).toHaveLength(1);
      expect((s.events[0] as { text: string }).text).toBe('hello world');
    });

    it('stops coalescing when a different event type arrives', () => {
      workflowStore.addEvent(makePlannerText({ text: 'a' }));
      workflowStore.addEvent(makePlannerStatus({ phase: 'specifying' }));
      workflowStore.addEvent(makePlannerText({ text: 'b' }));
      const s = workflowStore.get();
      expect(s.events).toHaveLength(3);
      expect((s.events[0] as { text: string }).text).toBe('a');
      expect((s.events[2] as { text: string }).text).toBe('b');
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

  describe('cost-update', () => {
    it('sets tokenUsage from cost-update event', () => {
      const event = makeCostUpdate();
      workflowStore.addEvent(event);
      expect(workflowStore.get().tokenUsage).toEqual(event.tokenUsage);
    });

    it('does not add cost-update to events array', () => {
      workflowStore.addEvent(makeCostUpdate());
      expect(workflowStore.get().events).toHaveLength(0);
    });

    it('overwrites previous tokenUsage', () => {
      workflowStore.addEvent(makeCostUpdate());
      const updated = { plannerInput: 999, plannerOutput: 999, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 };
      workflowStore.addEvent(makeCostUpdate({ tokenUsage: updated }));
      expect(workflowStore.get().tokenUsage).toEqual(updated);
    });
  });

  describe('task-complete counting', () => {
    it('does not increment escalatedCount for method=failed', () => {
      workflowStore.addEvent(makeTaskComplete({ method: 'failed' }));
      const s = workflowStore.get();
      expect(s.localCount).toBe(0);
      expect(s.escalatedCount).toBe(0);
    });

    it('increments escalatedCount for method=escalated-full', () => {
      workflowStore.addEvent(makeTaskComplete({ method: 'escalated-full' }));
      expect(workflowStore.get().escalatedCount).toBe(1);
    });

    it('does not increment any counter for method=skipped', () => {
      workflowStore.addEvent(makeTaskComplete({ method: 'skipped' }));
      const s = workflowStore.get();
      expect(s.localCount).toBe(0);
      expect(s.escalatedCount).toBe(0);
    });
  });

  describe('validate coalescing', () => {
    it('replaces running validate event with updated stages', () => {
      workflowStore.addEvent(makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } }));
      workflowStore.addEvent(makeValidate({ status: 'running', passed: false, stages: { tsc: true, lint: false, test: false } }));
      const events = workflowStore.get().events;
      expect(events).toHaveLength(1);
      expect((events[0] as { stages: { tsc: boolean } }).stages.tsc).toBe(true);
    });

    it('does not replace done validate with running', () => {
      workflowStore.addEvent(makeValidate({ status: 'done', passed: true, stages: { tsc: true, lint: true, test: true } }));
      workflowStore.addEvent(makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } }));
      expect(workflowStore.get().events).toHaveLength(2);
    });
  });

  describe('requestCancel', () => {
    it('sets cancelled and appends workflow-cancelled event', () => {
      workflowStore.addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
      workflowStore.requestCancel();
      const s = workflowStore.get();
      expect(s.cancelled).toBe(true);
      const last = s.events[s.events.length - 1];
      expect(last?.type).toBe('workflow-cancelled');
    });

    it('replaces running planner-status with done', () => {
      workflowStore.addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
      workflowStore.requestCancel();
      const s = workflowStore.get();
      const status = s.events.find(e => e.type === 'planner-status');
      expect(status && 'status' in status ? status.status : undefined).toBe('done');
    });

    it('is a no-op on double cancel', () => {
      workflowStore.requestCancel();
      const after1 = workflowStore.get().events.length;
      workflowStore.requestCancel();
      expect(workflowStore.get().events.length).toBe(after1);
    });

    it('drops error events after cancel', () => {
      workflowStore.requestCancel();
      workflowStore.addEvent({ type: 'error', ts: Date.now(), message: 'noise' });
      expect(workflowStore.get().events.filter(e => e.type === 'error')).toHaveLength(0);
    });

    it('drops planner-status events after cancel', () => {
      workflowStore.requestCancel();
      workflowStore.addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
      expect(workflowStore.get().events.filter(e => e.type === 'planner-status')).toHaveLength(0);
    });

    it('invokes the registered cancel handler', () => {
      const controller = new AbortController();
      workflowStore.setCancelHandler(() => controller.abort());
      workflowStore.requestCancel();
      expect(controller.signal.aborted).toBe(true);
    });

    it('does not throw when no cancel handler set', () => {
      expect(() => workflowStore.requestCancel()).not.toThrow();
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

    it('short-circuits when setReviewFile() called with same value', () => {
      workflowStore.setReviewFile('/tmp/spec.md');
      const before = workflowStore.get();
      workflowStore.setReviewFile('/tmp/spec.md');
      expect(workflowStore.get()).toBe(before);
    });
  });

});
