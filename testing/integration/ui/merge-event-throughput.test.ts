import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeEvent,
  eventsStore,
  MAX_EVENTS,
  MAX_MERGED_TEXT_LENGTH,
} from '../../../src/stores/workflow/events.js';
import { addEvent, getSections, resetWorkflow } from '../../../src/stores/workflow/actions.js';
import { groupEventsIntoSections } from '../../../src/core/sections/event-sections.js';
import { collectRunnerCallResult } from '../../../src/engine/calls/collector.js';
import { projectRunnerCallEvent } from '../../../src/engine/calls/event-projection.js';
import { runnerCallEventToSessionLogEntry } from '../../../src/engine/calls/session-log.js';
import type { RunnerCallEvent } from '../../../src/engine/calls/types.js';
import {
  makePlannerText,
  makeTaskStart,
  makeTaskComplete,
  makeImplementerGenerate,
} from '../../helpers/events.js';
import { taskId } from '../../../src/core/schemas/task.js';

beforeEach(() => {
  resetWorkflow();
});

const runnerCallBase = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'cli',
} as const;

function addProjectedRunnerEvent(event: RunnerCallEvent, sequence: number): void {
  const projected = projectRunnerCallEvent(event, { phase: 'planning', sequence });
  if (projected !== null) addEvent(projected);
}

function projectedSessionText(
  entry: ReturnType<typeof runnerCallEventToSessionLogEntry>,
): string | null {
  if (entry?.type !== 'runner_call_text_delta') return null;
  const data = entry.data;
  if (typeof data !== 'object' || data === null || !('text' in data)) return null;
  return typeof data.text === 'string' ? data.text : null;
}

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

  it('keeps workflow events bounded while runner text telemetry streams', () => {
    const runnerChunks = Array.from({ length: 1000 }, (_, i) => `hidden-${i}\n`);
    const textEvents = runnerChunks.map<RunnerCallEvent>((text, i) => ({
      type: 'call_text_delta',
      ts: i + 2,
      ...runnerCallBase,
      channel: 'assistant',
      text,
    }));
    const startEvent: RunnerCallEvent = { type: 'call_started', ts: 1, ...runnerCallBase };
    const terminalEvent: RunnerCallEvent = {
      type: 'call_completed',
      ts: 2000,
      ...runnerCallBase,
      status: 'completed',
      startedAt: 1,
      endedAt: 2000,
      durationMs: 1999,
      partial: false,
      error: null,
      usage: null,
      nativeSessionId: 'native-1',
    };
    const rawRunnerEvents = [startEvent, ...textEvents, terminalEvent];

    let sequence = 0;
    addProjectedRunnerEvent(startEvent, sequence);
    sequence += 1;
    for (const [index, event] of textEvents.entries()) {
      addEvent(makePlannerText({ phase: 'planning', text: `visible-${index}\n` }));
      addProjectedRunnerEvent(event, sequence);
      sequence += 1;
    }
    addProjectedRunnerEvent(terminalEvent, sequence);

    const workflowEvents = eventsStore.get().events;
    expect(workflowEvents.map((event) => event.type)).toEqual([
      'runner_call_started',
      'planner_text',
      'runner_call_completed',
    ]);

    const visiblePlannerEvent = workflowEvents.find((event) => event.type === 'planner_text');
    if (visiblePlannerEvent?.type !== 'planner_text') {
      throw new Error('Expected merged planner_text event');
    }
    expect(visiblePlannerEvent.text).toContain('visible-0');
    expect(visiblePlannerEvent.text).toContain('visible-999');

    expect(collectRunnerCallResult(rawRunnerEvents).text).toBe(runnerChunks.join(''));

    const sessionText = rawRunnerEvents
      .map((event, index) =>
        projectedSessionText(
          runnerCallEventToSessionLogEntry(event, { phase: 'planning', sequence: index }),
        ),
      )
      .filter((text) => text !== null)
      .join('');
    expect(sessionText).toBe(runnerChunks.join(''));
  });

  it('events store caps at MAX_EVENTS', () => {
    let events: ReturnType<typeof mergeEvent> = [];
    const count = MAX_EVENTS + 50;
    for (let i = 0; i < count; i++) {
      events = mergeEvent(
        events,
        makeTaskStart({
          taskId: taskId(`T${String((i % 999) + 1).padStart(3, '0')}`),
          title: `task-${i}`,
          index: i,
          total: count,
        }),
      );
    }

    expect(events.length).toBe(MAX_EVENTS);
    const first = events[0]! as { type: string; taskId: string };
    expect(first.taskId).not.toBe(taskId('T001'));
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

    const completedSections = sections.filter((s) => s.type === 'completed-task');
    expect(completedSections).toHaveLength(10);
  });
});
