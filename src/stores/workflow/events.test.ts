import { describe, it, expect, beforeEach } from 'vitest';
import { eventsStore, MAX_EVENTS, mergeEvent } from './events.js';
import { addEvent, resetWorkflow } from './actions.js';
import { taskId } from '../../core/schemas/task.js';
import type { TuiEvent } from '../../features/workflow/types.js';
import {
  makePlannerText,
  makePlannerStatus,
  makeValidate,
  makeRetry,
  makeCostUpdate,
} from '#testing/helpers/events.js';

describe('eventsStore — append via addEvent', () => {
  beforeEach(() => resetWorkflow());

  it('appends event to events array', () => {
    const event = makePlannerText();
    addEvent(event);
    const s = eventsStore.get();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toBe(event);
  });

  it('trims events to MAX_EVENTS when exceeded', () => {
    const events = Array.from({ length: MAX_EVENTS }, (_, i) => makeRetry({ taskId: taskId(`T${i}`) }));
    for (const e of events) addEvent(e);
    addEvent(makeRetry({ taskId: taskId('overflow') }));
    const s = eventsStore.get();
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect((s.events[s.events.length - 1] as { taskId: string }).taskId).toBe('overflow');
    expect((s.events[0] as { taskId: string }).taskId).toBe('T1');
  });

  it('coalesces consecutive planner-text events', () => {
    addEvent(makePlannerText({ text: 'hello ' }));
    addEvent(makePlannerText({ text: 'world' }));
    const s = eventsStore.get();
    expect(s.events).toHaveLength(1);
    expect((s.events[0] as { text: string }).text).toBe('hello world');
  });

  it('stops coalescing when a different event type arrives', () => {
    addEvent(makePlannerText({ text: 'a' }));
    addEvent(makePlannerStatus({ phase: 'specifying' }));
    addEvent(makePlannerText({ text: 'b' }));
    const s = eventsStore.get();
    expect(s.events).toHaveLength(3);
    expect((s.events[0] as { text: string }).text).toBe('a');
    expect((s.events[2] as { text: string }).text).toBe('b');
  });

  it('does not add cost-update to events array', () => {
    addEvent(makeCostUpdate());
    expect(eventsStore.get().events).toHaveLength(0);
  });

  describe('validate coalescing', () => {
    it('replaces running validate event with updated stages', () => {
      addEvent(makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } }));
      addEvent(makeValidate({ status: 'running', passed: false, stages: { tsc: true, lint: false, test: false } }));
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect((events[0] as { stages: { tsc: boolean } }).stages.tsc).toBe(true);
    });

    it('does not replace done validate with running', () => {
      addEvent(makeValidate({ status: 'done', passed: true, stages: { tsc: true, lint: true, test: true } }));
      addEvent(makeValidate({ status: 'running', passed: false, stages: { tsc: false, lint: false, test: false } }));
      expect(eventsStore.get().events).toHaveLength(2);
    });
  });
});

describe('mergeEvent (pure)', () => {
  it('does not coalesce when previous event is a different type', () => {
    const a = makePlannerStatus({ phase: 'specifying' });
    const b = makePlannerText({ text: 'hi' });
    const next = mergeEvent([a], b);
    expect(next).toHaveLength(2);
  });

  it('trims one event when events.length === MAX_EVENTS (circular buffer)', () => {
    const events: TuiEvent[] = Array.from({ length: MAX_EVENTS }, (_, i) => makeRetry({ taskId: taskId(`T${i}`) }));
    const incoming = makeRetry({ taskId: taskId('newest') });
    const next = mergeEvent(events, incoming);
    expect(next).toHaveLength(MAX_EVENTS);
    expect((next[0] as { taskId: string }).taskId).toBe('T1');
    expect((next[next.length - 1] as { taskId: string }).taskId).toBe('newest');
  });
});
