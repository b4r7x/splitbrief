import { describe, expect, it } from 'vitest';
import type { Phase } from '../../../src/core/schemas/enums.js';
import type { EngineEventOf } from '../../../src/engine/events/types.js';
import { deriveLiveStatus } from '../../../src/features/workflow/display/live-activity.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../src/stores/workflow/actions/reset.js';
import { lifecycleStore, type LifecycleState } from '../../../src/stores/workflow/lifecycle.js';

const PHASE_SEQUENCE: readonly Phase[] = [
  'researching',
  'specifying',
  'planning',
  'analyzing',
  'implementing',
];

function forceGc(): void {
  globalThis.gc?.();
}

function plannerText(ts: number, phase: Phase): EngineEventOf<'planner_text'> {
  return {
    type: 'planner_text',
    ts,
    phase,
    text: `planner update ${ts}`,
  };
}

// Ingests a whole workflow through the store dispatcher so phaseFirstSeenTs is derived exactly the
// way the footer sees it. The resulting map is O(#phases) regardless of eventCount.
function lifecycleAfterWorkflow(eventCount: number): LifecycleState {
  resetWorkflow();
  addEvent({ type: 'workflow_started', ts: 1, phase: 'researching', feature: 'live status perf' });
  const perPhase = Math.ceil(eventCount / PHASE_SEQUENCE.length);
  for (let index = 0; index < eventCount; index += 1) {
    const phase = PHASE_SEQUENCE[Math.floor(index / perPhase)] ?? 'implementing';
    addEvent(plannerText(index + 2, phase));
  }
  return lifecycleStore.get();
}

// Derivation loops finish in microseconds, where a single sample is at the mercy of GC and
// scheduler jitter; the ratio assertion compares the best of five samples instead.
function derivationLoopMs(state: LifecycleState): number {
  const input = {
    phase: state.phase,
    status: state.status,
    cancelled: state.cancelled,
    startedAt: state.startedAt,
    phaseFirstSeenTs: state.phaseFirstSeenTs,
  };
  let live = 0;
  const derivations = (): void => {
    for (let index = 0; index < 1_000; index += 1) {
      if (deriveLiveStatus(input) !== null) live += 1;
    }
  };
  derivations();
  let best = Number.POSITIVE_INFINITY;
  for (let rep = 0; rep < 5; rep += 1) {
    forceGc();
    const startedAt = performance.now();
    derivations();
    best = Math.min(best, performance.now() - startedAt);
  }
  expect(live).toBe(6_000);
  return best;
}

describe.skipIf(process.env.SPLITBRIEF_PERF !== '1')('input footer live status perf', () => {
  it('derives live status per tick in time independent of event count', () => {
    const small = lifecycleAfterWorkflow(1_000);
    const large = lifecycleAfterWorkflow(10_000);
    expect(Object.keys(small.phaseFirstSeenTs).length).toBe(PHASE_SEQUENCE.length);
    expect(Object.keys(large.phaseFirstSeenTs).length).toBe(PHASE_SEQUENCE.length);

    const smallMs = derivationLoopMs(small);
    const largeMs = derivationLoopMs(large);

    expect(smallMs).toBeLessThanOrEqual(10);
    expect(largeMs).toBeLessThanOrEqual(10);
    expect(largeMs).toBeLessThanOrEqual(smallMs * 2);
  });
});
