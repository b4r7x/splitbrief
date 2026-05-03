import { describe, it, expect, beforeEach } from 'vitest';
import { eventsStore, MAX_EVENTS } from './events.js';
import { addEvent, resetWorkflow } from './actions.js';
import { taskId } from '../../core/schemas/task.js';
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
      addEvent(makeValidate({ status: 'running', passed: false, stages: { typecheck: false, lint: false, test: false } }));
      addEvent(makeValidate({ status: 'running', passed: false, stages: { typecheck: true, lint: false, test: false } }));
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect((events[0] as { stages: { typecheck: boolean } }).stages.typecheck).toBe(true);
    });

    it('does not replace done validate with running', () => {
      addEvent(makeValidate({ status: 'done', passed: true, stages: { typecheck: true, lint: true, test: true } }));
      addEvent(makeValidate({ status: 'running', passed: false, stages: { typecheck: false, lint: false, test: false } }));
      expect(eventsStore.get().events).toHaveLength(2);
    });
  });

  describe('planner_heartbeat coalescing', () => {
    it('replaces consecutive heartbeat with the latest', () => {
      addEvent({ type: 'planner_heartbeat', ts: 1000, phase: 'planning', elapsedMs: 5000, accumulatedTokens: 100 });
      addEvent({ type: 'planner_heartbeat', ts: 3000, phase: 'planning', elapsedMs: 7000, accumulatedTokens: 200 });
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      const hb = events[0] as { type: string; elapsedMs: number; accumulatedTokens: number };
      expect(hb.elapsedMs).toBe(7000);
      expect(hb.accumulatedTokens).toBe(200);
    });

    it('does not replace heartbeat when a different event type intervenes', () => {
      addEvent({ type: 'planner_heartbeat', ts: 1000, phase: 'planning', elapsedMs: 5000, accumulatedTokens: 100 });
      addEvent(makePlannerText({ text: 'thinking' }));
      addEvent({ type: 'planner_heartbeat', ts: 3000, phase: 'planning', elapsedMs: 7000, accumulatedTokens: 200 });
      expect(eventsStore.get().events).toHaveLength(3);
    });
  });
});
