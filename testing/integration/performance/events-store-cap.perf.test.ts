import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent, EngineEventOf } from '../../../src/engine/events/types.js';
import { addEvent, resetWorkflow } from '../../../src/stores/workflow/actions.js';
import {
  eventsStore,
  MAX_EVENTS,
  MAX_MERGED_TEXT_LENGTH,
} from '../../../src/stores/workflow/events.js';

function forceGc(): void {
  globalThis.gc?.();
}

function warningEvent(index: number): EngineEventOf<'warning'> {
  return {
    type: 'warning',
    ts: index,
    phase: 'planning',
    message: `visible warning ${index}`,
  };
}

function plannerText(index: number, text: string): EngineEventOf<'planner_text'> {
  return {
    type: 'planner_text',
    ts: index,
    phase: 'planning',
    text,
  };
}

function workflowStarted(): EngineEventOf<'workflow_started'> {
  return {
    type: 'workflow_started',
    ts: 1,
    phase: 'idle',
    feature: 'large event store perf',
  };
}

function firstEventOfType<TType extends EngineEvent['type']>(
  events: readonly EngineEvent[],
  type: TType,
): Extract<EngineEvent, { type: TType }> {
  const event = events.find(
    (candidate): candidate is Extract<EngineEvent, { type: TType }> => candidate.type === type,
  );
  if (event === undefined) throw new Error(`Missing ${type} event`);
  return event;
}

describe.skipIf(process.env.DIPTYCH_PERF !== '1')('events store cap perf', () => {
  beforeEach(() => resetWorkflow());

  it('ingests past MAX_EVENTS while preserving structural transcript events', () => {
    addEvent(workflowStarted());
    forceGc();
    const count = MAX_EVENTS + 2_000;
    const startedAt = performance.now();
    for (let index = 0; index < count; index += 1) {
      addEvent(warningEvent(index));
    }
    const elapsedMs = performance.now() - startedAt;
    forceGc();

    const events = eventsStore.get().events;
    expect(events).toHaveLength(MAX_EVENTS);
    expect(events[0]).toMatchObject({ type: 'workflow_started' });
    expect(events.at(-1)).toMatchObject({
      type: 'warning',
      message: `visible warning ${count - 1}`,
    });
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('keeps merged planner text retained size flat after multi-megabyte ingestion', () => {
    const chunk = 'x'.repeat(4_096);
    const chunkCount = 2_048;
    const tailMarker = 'merged-text-tail-marker';
    const inputBytes = chunk.length * chunkCount + tailMarker.length;

    forceGc();
    const startedAt = performance.now();
    for (let index = 0; index < chunkCount; index += 1) {
      addEvent(plannerText(index, chunk));
    }
    addEvent(plannerText(chunkCount, tailMarker));
    const elapsedMs = performance.now() - startedAt;
    forceGc();

    const merged = firstEventOfType(eventsStore.get().events, 'planner_text');
    expect(merged.text).toHaveLength(MAX_MERGED_TEXT_LENGTH);
    expect(merged.text.endsWith(tailMarker)).toBe(true);
    expect(merged.text.length / inputBytes).toBeLessThan(0.08);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
