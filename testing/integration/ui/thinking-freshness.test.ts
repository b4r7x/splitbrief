import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeRunnerCallStalled } from '#testing/helpers/events/runner-call.js';
import { taskId } from '../../../src/core/schemas/task.js';
import { projectRunnerCallEvents } from '../../../src/engine/calls/event-projection.js';
import { createStreamHandler } from '../../../src/engine/runners/claude/stream.js';
import { deriveBuildProgress } from '../../../src/features/workflow/display/build-progress.js';
import { addEvent } from '../../../src/stores/workflow/actions/event.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { operationsStore } from '../../../src/stores/workflow/operations/state.js';
import { tasksStore } from '../../../src/stores/workflow/tasks.js';

const T0 = Date.parse('2026-09-25T09:00:00.000Z');

function freshness(now: number): string {
  return deriveBuildProgress({
    tasks: tasksStore.get(),
    lifecycle: lifecycleStore.get(),
    operations: operationsStore.get(),
    now,
  }).freshness;
}

/**
 * Claude Code frames through the Claude stream handler, its call recorder and the event projection
 * into the stores. A live build call parses them in the claude-code CLI adapter instead; both end
 * in the same recorder heartbeat.
 */
function claudeBuildCall(): (frame: Record<string, unknown>) => void {
  let sequence = 0;
  const { handleLine } = createStreamHandler({
    context: {
      callId: 'thinking-freshness',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'claude-code',
      taskId: taskId('T001'),
    },
    onOutput: () => {},
    onCallEvent: (event) => {
      for (const projected of projectRunnerCallEvents(event, {
        rootDir: '/project',
        phase: 'implementing',
        sequence: sequence++,
      })) {
        addEvent(projected);
      }
    },
  });
  return (frame) => handleLine(JSON.stringify({ session_id: 'sess-thinking', ...frame }));
}

describe('build block freshness while Claude Code thinks', () => {
  beforeEach(() => {
    resetAllStores();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    addEvent({ type: 'workflow_started', ts: T0, phase: 'implementing', feature: 'freshness' });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAllStores();
  });

  it('stays current on thinking-token frames and states the watchdog silence once it warns', () => {
    const frame = claudeBuildCall();
    for (let second = 10; second <= 100; second += 10) {
      vi.setSystemTime(T0 + second * 1000);
      frame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: second * 20 });
    }

    expect(freshness(T0 + 100_000)).toBe('last event 0s ago');
    // The runner's own warn timing decides when a real stall lands (`RUNNER_IDLE_WARN_MS`, five
    // minutes by default); this stages the stall at the 60-second UI floor and checks the span.
    addEvent(
      makeRunnerCallStalled({
        ts: T0 + 160_000,
        silentMs: 60_000,
        runnerName: 'claude-code',
      }),
    );
    expect(freshness(T0 + 161_000)).toBe('No output for 1:01');
  });

  it('moves the stores once for a burst of bookkeeping frames', () => {
    const frame = claudeBuildCall();
    vi.setSystemTime(T0 + 9_000);
    frame({ type: 'system', subtype: 'init' });
    let updates = 0;
    const unsubscribe = lifecycleStore.subscribe(() => {
      updates += 1;
    });

    for (let ms = 0; ms < 1_000; ms += 50) {
      vi.setSystemTime(T0 + 10_000 + ms);
      frame({ type: 'system', subtype: 'status', status: 'requesting' });
    }
    unsubscribe();

    expect(updates).toBe(1);
    expect(freshness(T0 + 11_000)).toBe('last event 1s ago');
  });
});
