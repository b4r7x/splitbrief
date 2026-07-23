import { beforeEach, describe, expect, it } from 'vitest';
import { createTuiSink } from './tui-sink.js';
import { createEventBus } from '../../engine/events/bus.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import { normalizeRunnerCallWarning } from '../../engine/calls/warnings.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { operationsStore } from '../../stores/workflow/operations/state.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import type { EngineEvent } from '../../engine/events/types.js';

describe('tuiSink', () => {
  beforeEach(() => resetWorkflow());

  it('accumulates multiple engine error events in the events store in order via the bus and TUI sink', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    bus.publish(makeErrorEvent({ message: 'first error', ts: 1 }));
    bus.publish(makeErrorEvent({ message: 'second error', ts: 2 }));
    bus.publish(makeErrorEvent({ message: 'third error', ts: 3 }));

    const errors = eventsStore
      .get()
      .events.filter(
        (event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error',
      );
    expect(errors).toHaveLength(3);
    expect(errors[0]?.message).toBe('first error');
    expect(errors[1]?.message).toBe('second error');
    expect(errors[2]?.message).toBe('third error');
  });

  it('updates the tasks sub-store when a task_started event is published', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    bus.publish(makeTaskStart({ index: 2, total: 5 }));

    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(5);
  });

  it('respects the store cancel gate after local cancellation intent', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    markCancellationRequested();
    const beforeLen = eventsStore.get().events.length;

    bus.publish(makePlannerText({ text: 'post-cancel' }));

    expect(eventsStore.get().events.length).toBe(beforeLen);
    expect(lifecycleStore.get().cancelled).toBe(true);
  });

  it('protects live workflow stores when transcript persistence is disabled', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink({ persistTranscript: false }));
    const secret = 'private-runner-output-92741';

    bus.publish(makePlannerText({ text: secret }));
    bus.publish(runnerStarted());
    bus.publish({
      type: 'runner_call_activity',
      ts: 1_100,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      activityId: 'call-1:command',
      stage: 'completed',
      kind: 'command',
      label: 'running command',
      target: `npm test ${secret}`,
      redacted: false,
      rawAvailable: true,
      expandId: `raw-${secret}`,
      textPartial: `stdout ${secret}`,
      diagnosticPartial: `stderr ${secret}`,
    });
    bus.publish({
      type: 'runner_call_warning',
      ts: 1_200,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 3,
      warning: normalizeRunnerCallWarning({
        code: 'provider_warning',
        message: `warning ${secret}`,
        surface: 'activity',
      }),
    });
    bus.publish({
      type: 'runner_call_error',
      ts: 1_900,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 4,
      status: 'failed',
      error: { code: 'failed', message: `failed ${secret}` },
      partial: true,
      startedAt: 1_000,
      endedAt: 1_900,
      durationMs: 900,
      usage: { inputTokens: 1, outputTokens: 2 },
      nativeSessionId: `session-${secret}`,
    });

    expect(eventsStore.get().events).toEqual([
      expect.objectContaining({
        type: 'runner_call_activity',
        label: 'running command',
      }),
    ]);
    expect(eventsStore.get().events[0]).not.toHaveProperty('rawAvailable');
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(secret);

    expect(operationsStore.get().last).toMatchObject({
      status: 'failed',
      reason: '[transcript omitted]',
      warnings: [
        expect.objectContaining({
          latestMessage: '[transcript omitted]',
        }),
      ],
    });
    expect(JSON.stringify(operationsStore.get())).not.toContain(secret);
  });

  it('omits queued message previews from live stores when transcript persistence is disabled', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink({ persistTranscript: false }));
    const secret = 'private inline resume text';

    bus.publish({
      type: 'message_queued',
      ts: 1_000,
      phase: 'implementing',
      id: 'msg-1',
      queueDepth: 1,
      preview: secret,
    });

    expect(eventsStore.get().events).toEqual([
      {
        type: 'message_queued',
        ts: 1_000,
        phase: 'implementing',
        id: 'msg-1',
        queueDepth: 1,
      },
    ]);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(secret);
  });
});

function runnerStarted(
  overrides?: Partial<EngineEventOf<'runner_call_started'>>,
): EngineEventOf<'runner_call_started'> {
  return {
    type: 'runner_call_started',
    ts: 1_000,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 1,
    runnerName: 'codex',
    model: 'gpt-5-mini',
    ...overrides,
  };
}

function makeErrorEvent(overrides?: Partial<EngineEventOf<'error'>>): EngineEventOf<'error'> {
  return {
    type: 'error',
    ts: Date.now(),
    phase: 'implementing',
    message: 'Something went wrong',
    ...overrides,
  };
}
