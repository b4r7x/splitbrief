import { describe, it, expect } from 'vitest';
import { mergeEvent, updateCounts, updateTaskMap, MAX_EVENTS } from './workflow-reducers.js';
import { taskId } from '../core/types/workflow.js';
import {
  makePlannerText,
  makePlannerStatus,
  makeValidate,
  makeTaskStart,
  makeTaskComplete,
  makeTaskSkipped,
  makeRetry,
} from '#testing/helpers/events.js';
import type { SidebarTask, TuiEvent } from '../types.js';
import type { WorkflowViewState } from './workflow.js';

const emptyState: WorkflowViewState = {
  events: [],
  sections: [],
  phase: 'idle',
  currentTask: 0,
  totalTasks: 0,
  localCount: 0,
  escalatedCount: 0,
  taskCompletionTimes: [],
  taskMap: new Map(),
  tasks: [],
  tokenUsage: null,
  cancelled: false,
  queueDepth: 0,
};

describe('mergeEvent', () => {
  it('appends an event to an empty list', () => {
    const event = makePlannerText({ text: 'hi' });
    const next = mergeEvent([], event);
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(event);
  });

  it('coalesces consecutive planner-text events', () => {
    const a = makePlannerText({ text: 'foo ' });
    const b = makePlannerText({ text: 'bar' });
    const next = mergeEvent([a], b);
    expect(next).toHaveLength(1);
    expect((next[0] as { text: string }).text).toBe('foo bar');
  });

  it('replaces a running validate event with a newer running validate', () => {
    const first = makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } });
    const second = makeValidate({ status: 'running', passed: false, stages: { tsc: true, lint: false, test: false } });
    const next = mergeEvent([first], second);
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(second);
  });

  it('trims one event when events.length === MAX_EVENTS (circular buffer)', () => {
    const events: TuiEvent[] = Array.from({ length: MAX_EVENTS }, (_, i) => makeRetry({ taskId: taskId(`T${i}`) }));
    const incoming = makeRetry({ taskId: taskId('newest') });
    const next = mergeEvent(events, incoming);
    expect(next).toHaveLength(MAX_EVENTS);
    expect((next[0] as { taskId: string }).taskId).toBe('T1');
    expect((next[next.length - 1] as { taskId: string }).taskId).toBe('newest');
  });

  it('does not coalesce when previous event is a different type', () => {
    const a = makePlannerStatus({ phase: 'specifying' });
    const b = makePlannerText({ text: 'hi' });
    const next = mergeEvent([a], b);
    expect(next).toHaveLength(2);
  });
});

describe('updateCounts', () => {
  it('updates phase on planner-status', () => {
    const next = updateCounts(emptyState, makePlannerStatus({ phase: 'researching' }));
    expect(next.phase).toBe('researching');
  });

  it('increments localCount on task-complete with method=local', () => {
    const next = updateCounts({ ...emptyState, localCount: 2 }, makeTaskComplete({ method: 'local' }));
    expect(next.localCount).toBe(3);
  });

  it('increments escalatedCount on task-complete with escalated-hint/escalated-full', () => {
    const hintNext = updateCounts(emptyState, makeTaskComplete({ method: 'escalated-hint' }));
    expect(hintNext.escalatedCount).toBe(1);
    const fullNext = updateCounts(emptyState, makeTaskComplete({ method: 'escalated-full' }));
    expect(fullNext.escalatedCount).toBe(1);
  });

  it('tracks task duration on task-complete', () => {
    const next = updateCounts(
      { ...emptyState, taskCompletionTimes: [3000] },
      makeTaskComplete({ method: 'local', duration: 5000 }),
    );
    expect(next.taskCompletionTimes).toEqual([3000, 5000]);
  });

  it('sets currentTask and totalTasks on task-start', () => {
    const next = updateCounts(emptyState, makeTaskStart({ index: 2, total: 5 }));
    expect(next.currentTask).toBe(3);
    expect(next.totalTasks).toBe(5);
  });
});

describe('updateTaskMap', () => {
  it('adds an in_progress task on task-start', () => {
    const next = updateTaskMap(new Map(), makeTaskStart({ taskId: taskId('T010'), title: 'New' }));
    expect(next.get('T010')).toEqual({ id: 'T010', title: 'New', status: 'in_progress' });
  });

  it('marks a task done on task-complete when it exists', () => {
    const existing = new Map<string, SidebarTask>([
      ['T001', { id: 'T001', title: 'Test', status: 'in_progress' }],
    ]);
    const next = updateTaskMap(existing, makeTaskComplete({ taskId: taskId('T001') }));
    expect(next.get('T001')!.status).toBe('done');
  });

  it('marks a task skipped on task-skipped when it exists', () => {
    const existing = new Map<string, SidebarTask>([
      ['T002', { id: 'T002', title: 'Other', status: 'in_progress' }],
    ]);
    const next = updateTaskMap(existing, makeTaskSkipped({ taskId: taskId('T002') }));
    expect(next.get('T002')!.status).toBe('skipped');
  });

  it('returns the same map when a task-complete references an unknown taskId', () => {
    const existing = new Map<string, SidebarTask>();
    const next = updateTaskMap(existing, makeTaskComplete({ taskId: taskId('UNKNOWN') }));
    expect(next).toBe(existing);
  });

  it('status unchanged returns original map', () => {
    const existing = new Map<string, SidebarTask>([
      ['T003', { id: 'T003', title: 'Already done', status: 'done' }],
    ]);
    const next = updateTaskMap(existing, makeTaskComplete({ taskId: taskId('T003') }));
    expect(next).toBe(existing);
  });
});
