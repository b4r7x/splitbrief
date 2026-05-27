import { describe, it, expect, beforeEach } from 'vitest';
import { mergeEvent, eventsStore, MAX_EVENTS, MAX_MERGED_TEXT_LENGTH } from '../../../src/stores/workflow/events.js';
import { addEvent, getSections, resetWorkflow } from '../../../src/stores/workflow/actions.js';
import { groupEventsIntoSections } from '../../../src/core/layout/event-sections.js';
import { makePlannerText, makeTaskStart, makeTaskComplete, makeImplementerGenerate } from '../../helpers/events.js';
import { taskId } from '../../../src/core/schemas/task.js';

beforeEach(() => {
  resetWorkflow();
});

describe('mergeEvent throughput', () => {
  it('coalesces sequential planner_text events into one', () => {
    let events = mergeEvent([], makePlannerText({ text: 'chunk-0' }));
    for (let i = 1; i < 1000; i++) {
      events = mergeEvent(events, makePlannerText({ text: `chunk-${i}` }));
    }

    expect(events).toHaveLength(1);
    const merged = events[0]!;
    expect(merged.type).toBe('planner_text');
    expect((merged as { text: string }).text).toContain('chunk-0');
    expect((merged as { text: string }).text).toContain('chunk-999');
  });

  it('enforces MAX_MERGED_TEXT_LENGTH cap', () => {
    const bigChunk = 'x'.repeat(100_000);
    let events = mergeEvent([], makePlannerText({ text: bigChunk }));
    for (let i = 1; i < 10; i++) {
      events = mergeEvent(events, makePlannerText({ text: bigChunk }));
    }

    expect(events).toHaveLength(1);
    const merged = events[0]! as { text: string };
    expect(merged.text.length).toBe(MAX_MERGED_TEXT_LENGTH);
    expect(merged.text.endsWith(bigChunk)).toBe(true);
  });

  it('events store caps at MAX_EVENTS', () => {
    let events: ReturnType<typeof mergeEvent> = [];
    const count = MAX_EVENTS + 50;
    for (let i = 0; i < count; i++) {
      events = mergeEvent(events, makeTaskStart({
        taskId: taskId(`T${String(i).padStart(5, '0')}`),
        title: `task-${i}`,
        index: i,
        total: count,
      }));
    }

    expect(events.length).toBe(MAX_EVENTS);
    const first = events[0]! as { type: string; taskId: string };
    expect(first.taskId).not.toBe(taskId('T00000'));
  });

  it('section cache returns same reference for unchanged events', () => {
    addEvent(makePlannerText({ text: 'hello' }));
    const a = getSections();
    const b = getSections();
    expect(a).toBe(b);
  });

  it('large event volume renders without crash', () => {
    for (let t = 0; t < 10; t++) {
      const tid = taskId(`T${String(t).padStart(3, '0')}`);
      addEvent(makeTaskStart({ taskId: tid, title: `task-${t}`, index: t, total: 10 }));
      for (let g = 0; g < 10; g++) {
        addEvent(makeImplementerGenerate({ taskId: tid }));
      }
      addEvent(makeTaskComplete({ taskId: tid, title: `task-${t}` }));
    }

    const { events } = eventsStore.get();
    expect(events.length).toBeGreaterThan(0);

    const sections = groupEventsIntoSections(events);
    expect(sections.length).toBeGreaterThan(0);

    const completedSections = sections.filter(s => s.type === 'completed-task');
    expect(completedSections).toHaveLength(10);
  });
});
