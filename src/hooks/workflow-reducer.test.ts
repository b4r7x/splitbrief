import { describe, it, expect } from 'vitest';
import { workflowReducer, MAX_EVENTS } from './workflow-reducer.js';
import { makeHookWorkflowState } from '#testing/helpers/fixtures.js';
import {
  makePlannerStatus,
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeRetry,
} from '#testing/helpers/events.js';

describe('workflowReducer', () => {
  describe('ADD_EVENT', () => {
    it('appends event to events array', () => {
      const state = makeHookWorkflowState();
      const event = makePlannerText();
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.events).toHaveLength(1);
      expect(next.events[0]).toBe(event);
    });

    it('updates phase when planner-status event received', () => {
      const state = makeHookWorkflowState({ phase: 'idle' });
      const event = makePlannerStatus({ phase: 'specifying' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.phase).toBe('specifying');
    });

    it('updates currentTask and totalTasks on task-start', () => {
      const state = makeHookWorkflowState();
      const event = makeTaskStart({ index: 2, total: 5 });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.currentTask).toBe(3);
      expect(next.totalTasks).toBe(5);
    });

    it('adds task to taskMap as in_progress on task-start', () => {
      const state = makeHookWorkflowState();
      const event = makeTaskStart({ taskId: 'T010', title: 'New task' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.taskMap.get('T010')).toEqual({ id: 'T010', title: 'New task', status: 'in_progress' });
    });

    it('increments localCount on task-complete with method=local', () => {
      const state = makeHookWorkflowState({ localCount: 1 });
      const event = makeTaskComplete({ method: 'local' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.localCount).toBe(2);
    });

    it('increments escalatedCount on task-complete with method=escalated', () => {
      const state = makeHookWorkflowState({ escalatedCount: 0 });
      const event = makeTaskComplete({ method: 'escalated' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.escalatedCount).toBe(1);
    });

    it('updates taskMap status to done on task-complete', () => {
      const taskMap = new Map([['T001', { id: 'T001', title: 'Test', status: 'in_progress' as const }]]);
      const state = makeHookWorkflowState({ taskMap });
      const event = makeTaskComplete({ taskId: 'T001' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.taskMap.get('T001')!.status).toBe('done');
    });

    it('updates taskMap status to skipped on task-skipped', () => {
      const taskMap = new Map([['T001', { id: 'T001', title: 'Test', status: 'in_progress' as const }]]);
      const state = makeHookWorkflowState({ taskMap });
      const event = makeTaskSkipped({ taskId: 'T001' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.taskMap.get('T001')!.status).toBe('skipped');
    });

    it('does not update taskMap for unknown taskId on task-complete', () => {
      const state = makeHookWorkflowState();
      const event = makeTaskComplete({ taskId: 'UNKNOWN' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.taskMap.size).toBe(0);
      expect(next.taskMap).toBe(state.taskMap);
    });

    it('trims events to MAX_EVENTS when exceeded', () => {
      const events = Array.from({ length: MAX_EVENTS }, (_, i) => makePlannerText({ text: `msg-${i}` }));
      const state = makeHookWorkflowState({ events });
      const event = makePlannerText({ text: 'overflow' });
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.events).toHaveLength(MAX_EVENTS);
      expect(next.events[next.events.length - 1]).toBe(event);
      expect((next.events[0] as { text: string }).text).toBe('msg-1');
    });

    it('preserves other state fields on generic events', () => {
      const state = makeHookWorkflowState({ phase: 'implementing', localCount: 3, escalatedCount: 1 });
      const event = makeRetry();
      const next = workflowReducer(state, { type: 'ADD_EVENT', event });
      expect(next.phase).toBe('implementing');
      expect(next.localCount).toBe(3);
      expect(next.escalatedCount).toBe(1);
    });
  });

  describe('SET_REVIEW_FILE', () => {
    it('sets reviewFilePath', () => {
      const state = makeHookWorkflowState();
      const next = workflowReducer(state, { type: 'SET_REVIEW_FILE', path: '/tmp/spec.md' });
      expect(next.reviewFilePath).toBe('/tmp/spec.md');
    });

    it('clears reviewFilePath when null', () => {
      const state = makeHookWorkflowState({ reviewFilePath: '/tmp/spec.md' });
      const next = workflowReducer(state, { type: 'SET_REVIEW_FILE', path: null });
      expect(next.reviewFilePath).toBeNull();
    });
  });
});
