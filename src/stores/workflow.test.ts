import { describe, it, expect, beforeEach } from 'vitest';
import { workflowStore, mergeEvent, updateCounts, updateTaskMap, MAX_EVENTS } from './workflow.js';
import type { WorkflowState } from './workflow.js';
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
      const event = makeTaskComplete({ method: 'escalated-hint' });
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
      const events = Array.from({ length: MAX_EVENTS }, (_, i) => makeRetry({ taskId: `T${i}` }));
      for (const e of events) workflowStore.addEvent(e);
      workflowStore.addEvent(makeRetry({ taskId: 'overflow' }));
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
      expect(last.type).toBe('workflow-cancelled');
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

    it('aborts the abort controller signal', () => {
      const controller = new AbortController();
      workflowStore.setAbortController(controller);
      workflowStore.requestCancel();
      expect(controller.signal.aborted).toBe(true);
    });

    it('does not throw when no abort controller set', () => {
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

  describe('pure functions', () => {
    describe('mergeEvent', () => {
      it('returns array with event when events is empty', () => {
        const event = makePlannerText({ text: 'hello' });
        const result = mergeEvent([], event);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(event);
      });

      it('merges consecutive planner-text events', () => {
        const first = makePlannerText({ text: 'hello ' });
        const second = makePlannerText({ text: 'world' });
        const result = mergeEvent([first], second);
        expect(result).toHaveLength(1);
        expect((result[0] as { text: string }).text).toBe('hello world');
      });

      it('does not merge planner-text after non-planner-text', () => {
        const status = makePlannerStatus();
        const text = makePlannerText({ text: 'hello' });
        const result = mergeEvent([status], text);
        expect(result).toHaveLength(2);
      });

      it('replaces running validate with another running validate', () => {
        const v1 = makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } });
        const v2 = makeValidate({ status: 'running', passed: false, stages: { tsc: true, lint: false, test: false } });
        const result = mergeEvent([v1], v2);
        expect(result).toHaveLength(1);
        expect((result[0] as { stages: { tsc: boolean } }).stages.tsc).toBe(true);
      });

      it('does not replace done validate with running validate', () => {
        const v1 = makeValidate({ status: 'done', passed: true, stages: { tsc: true, lint: true, test: true } });
        const v2 = makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } });
        const result = mergeEvent([v1], v2);
        expect(result).toHaveLength(2);
      });

      it('trims to MAX_EVENTS when exceeded', () => {
        const events = Array.from({ length: MAX_EVENTS }, (_, i) => makeRetry({ taskId: `T${i}` }));
        const overflow = makeRetry({ taskId: 'overflow' });
        const result = mergeEvent(events, overflow);
        expect(result).toHaveLength(MAX_EVENTS);
        expect((result[result.length - 1] as { taskId: string }).taskId).toBe('overflow');
        expect((result[0] as { taskId: string }).taskId).toBe('T1');
      });
    });

    describe('updateCounts', () => {
      const base: Pick<WorkflowState, 'phase' | 'currentTask' | 'totalTasks' | 'localCount' | 'escalatedCount'> = {
        phase: 'idle',
        currentTask: 0,
        totalTasks: 0,
        localCount: 0,
        escalatedCount: 0,
      };
      const state = base as WorkflowState;

      it('updates phase on planner-status', () => {
        const result = updateCounts(state, makePlannerStatus({ phase: 'specifying' }));
        expect(result.phase).toBe('specifying');
      });

      it('updates currentTask and totalTasks on task-start', () => {
        const result = updateCounts(state, makeTaskStart({ index: 2, total: 5 }));
        expect(result.currentTask).toBe(3);
        expect(result.totalTasks).toBe(5);
      });

      it('increments localCount on task-complete with method=local', () => {
        const result = updateCounts(state, makeTaskComplete({ method: 'local' }));
        expect(result.localCount).toBe(1);
      });

      it('increments escalatedCount on task-complete with method=escalated-hint', () => {
        const result = updateCounts(state, makeTaskComplete({ method: 'escalated-hint' }));
        expect(result.escalatedCount).toBe(1);
      });

      it('does not increment any counter on task-complete with method=failed', () => {
        const result = updateCounts(state, makeTaskComplete({ method: 'failed' }));
        expect(result.localCount).toBe(0);
        expect(result.escalatedCount).toBe(0);
      });

      it('changes nothing for unrelated event type', () => {
        const result = updateCounts(state, makePlannerText());
        expect(result).toEqual(base);
      });
    });

    describe('updateTaskMap', () => {
      it('adds new entry on task-start', () => {
        const map = new Map();
        const result = updateTaskMap(map, makeTaskStart({ taskId: 'T010', title: 'New task' }));
        expect(result.get('T010')).toEqual({ id: 'T010', title: 'New task', status: 'in_progress' });
      });

      it('updates existing entry to done on task-complete', () => {
        const map = new Map([['T001', { id: 'T001', title: 'Test', status: 'in_progress' as const }]]);
        const result = updateTaskMap(map, makeTaskComplete({ taskId: 'T001' }));
        expect(result.get('T001')!.status).toBe('done');
      });

      it('returns same map reference for task-complete with nonexistent taskId', () => {
        const map = new Map();
        const result = updateTaskMap(map, makeTaskComplete({ taskId: 'MISSING' }));
        expect(result).toBe(map);
      });

      it('updates existing entry to skipped on task-skipped', () => {
        const map = new Map([['T001', { id: 'T001', title: 'Test', status: 'in_progress' as const }]]);
        const result = updateTaskMap(map, makeTaskSkipped({ taskId: 'T001' }));
        expect(result.get('T001')!.status).toBe('skipped');
      });
    });
  });
});
