import { describe, it, expect, beforeEach } from 'vitest';
import { eventsStore } from '../../../src/stores/workflow/events.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { collectRunnerCallResult } from '../../../src/engine/calls/collector.js';
import { projectRunnerCallEvent } from '../../../src/engine/calls/event-projection.js';
import { runnerCallEventToSessionLogEntry } from '../../../src/engine/calls/session-log.js';
import type { RunnerCallEvent } from '../../../src/engine/calls/types.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';

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
    expect(workflowEvents.map((event) => event.type)).toEqual(['planner_text']);

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
});
