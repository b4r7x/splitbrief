import { describe, it, expect, beforeEach } from 'vitest';
import {
  eventsStore,
  MAX_EVENTS,
  MAX_MERGED_TEXT_LENGTH,
  mergeEvent,
  projectEventForTuiEventLog,
} from './events.js';
import { addEvent } from './actions/event.js';
import { resetWorkflow } from './actions/reset.js';
import { taskId } from '../../core/schemas/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import { protectEngineEventForConsumer } from '../../engine/events/protection/protect.js';
import type { RunnerCallWarningInput } from '../../engine/calls/types.js';
import { normalizeRunnerCallWarning } from '../../engine/calls/warnings.js';
import { makePlannerText, makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import {
  makeTaskStart,
  makeValidate,
  makeRetry,
  makeCostUpdate,
} from '#testing/helpers/events/task.js';
import { operationsStore } from './operations/state.js';

function makeRunnerTextDelta(
  overrides?: Partial<EngineEventOf<'runner_call_text_delta'>>,
): EngineEventOf<'runner_call_text_delta'> {
  return {
    type: 'runner_call_text_delta',
    ts: Date.now(),
    phase: 'implementing',
    callId: 'call-1',
    role: 'planner',
    backendKind: 'cli',
    sequence: 1,
    channel: 'assistant',
    text: 'hidden telemetry',
    ...overrides,
  };
}

function makeRunnerStarted(
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

function makeRunnerWarning(
  overrides?: Partial<Omit<EngineEventOf<'runner_call_warning'>, 'warning'>> & {
    warning?: RunnerCallWarningInput;
  },
): EngineEventOf<'runner_call_warning'> {
  const { warning, ...eventOverrides } = overrides ?? {};
  return {
    type: 'runner_call_warning',
    ts: 1_100,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    warning: normalizeRunnerCallWarning(
      warning ?? {
        code: 'provider_warning',
        message: 'provider warning',
        surface: 'activity',
      },
    ),
    ...eventOverrides,
  };
}

function makeRunnerError(
  overrides?: Partial<EngineEventOf<'runner_call_error'>>,
): EngineEventOf<'runner_call_error'> {
  return {
    type: 'runner_call_error',
    ts: 1_900,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 7,
    status: 'failed',
    error: { code: 'failed', message: 'failed' },
    partial: true,
    startedAt: 1_000,
    endedAt: 1_900,
    durationMs: 900,
    usage: { inputTokens: 1, outputTokens: 2 },
    nativeSessionId: null,
    ...overrides,
  };
}

function makeRunnerActivity(
  overrides?: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return makeRunnerCallActivity({
    ts: 1_200,
    phase: 'implementing',
    sequence: 3,
    activityId: 'call-1:tool:1',
    label: 'running npm test',
    target: 'npm test',
    ...overrides,
  });
}

function makeValidationBaseline(
  overrides?: Partial<EngineEventOf<'validation_baseline'>>,
): EngineEventOf<'validation_baseline'> {
  return {
    type: 'validation_baseline',
    ts: Date.now(),
    phase: 'implementing',
    status: 'done',
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

describe('eventsStore — append via addEvent', () => {
  beforeEach(() => resetWorkflow());

  it('appends event to events array', () => {
    const event = makePlannerText();
    addEvent(event);
    const s = eventsStore.get();
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toEqual(event);
    const stored = s.events[0];
    addEvent(makePlannerStatus({ phase: 'specifying' }));
    expect(eventsStore.get().events).toHaveLength(2);
    expect(eventsStore.get().events[0]).toBe(stored);
    expect(eventsStore.get().events[0]).toEqual(event);
  });

  it('trims events to MAX_EVENTS when exceeded', () => {
    const events = Array.from({ length: MAX_EVENTS }, (_, i) =>
      makeRetry({ taskId: taskId(`T${String((i % 999) + 1).padStart(3, '0')}`) }),
    );
    for (const e of events) addEvent(e);
    addEvent(makeRetry({ taskId: taskId('T999') }));
    const s = eventsStore.get();
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect((s.events[s.events.length - 1] as { taskId: string }).taskId).toBe('T999');
    expect((s.events[0] as { taskId: string }).taskId).toBe('T002');
  });

  it('preserves structural task events before evicting ordinary activity', () => {
    const structural = makeTaskStart({ taskId: taskId('T001'), index: 0 });
    const events = [
      structural,
      ...Array.from({ length: MAX_EVENTS - 1 }, (_, i) =>
        makeRetry({ taskId: taskId(`T${String((i % 998) + 2).padStart(3, '0')}`) }),
      ),
    ];

    const result = mergeEvent(events, makeRetry({ taskId: taskId('T999') }));

    expect(result).toHaveLength(MAX_EVENTS);
    expect(result).toContain(structural);
    expect(result[0]).toBe(structural);
    expect((result[result.length - 1] as { taskId: string }).taskId).toBe('T999');
  });

  it('hard-caps all-structural task_started streams at MAX_EVENTS', () => {
    const first = makeTaskStart({
      taskId: taskId('T001'),
      index: 0,
      title: 'first',
      total: MAX_EVENTS + 1,
    });
    let events = mergeEvent([], first);
    for (let i = 2; i <= MAX_EVENTS; i += 1) {
      events = mergeEvent(
        events,
        makeTaskStart({
          taskId: taskId(`T${String((i % 998) + 2).padStart(3, '0')}`),
          index: i - 1,
          title: `task-${i}`,
          total: MAX_EVENTS + 1,
        }),
      );
    }
    expect(events).toHaveLength(MAX_EVENTS);

    const overflow = makeTaskStart({
      taskId: taskId('T999'),
      index: MAX_EVENTS,
      title: 'overflow',
      total: MAX_EVENTS + 1,
    });
    const capped = mergeEvent(events, overflow);
    expect(capped).toHaveLength(MAX_EVENTS);
    expect(capped[0]).not.toBe(first);
    expect(capped[capped.length - 1]).toBe(overflow);
  });

  it('coalesces consecutive planner-text events', () => {
    addEvent(makePlannerText({ text: 'hello ' }));
    addEvent(makePlannerText({ text: 'world' }));
    const s = eventsStore.get();
    expect(s.events).toHaveLength(1);
    expect((s.events[0] as { text: string }).text).toBe('hello world');
  });

  it('omits runner call text deltas and keeps visible planner text coalesced', () => {
    addEvent(makePlannerText({ text: 'visible ' }));
    addEvent(makeRunnerTextDelta({ text: 'hidden' }));
    addEvent(makePlannerText({ text: 'continued' }));

    const events = eventsStore.get().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'planner_text',
      text: 'visible continued',
    });
  });

  it('keeps only safe runner activity in the retained event log while raw stores update', () => {
    const rawSentinel = 'raw-runner-sentinel-92741';
    addEvent(makeRunnerStarted());
    addEvent(makeRunnerTextDelta({ text: `assistant ${rawSentinel}` }));
    addEvent({
      type: 'runner_call_tool_use',
      ts: 1_050,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      stage: 'delta',
      toolUseId: 'tool-1',
      name: 'Bash',
      inputDelta: `{"command":"echo ${rawSentinel}"}`,
    });
    addEvent({
      type: 'runner_call_tool_use',
      ts: 1_060,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 3,
      stage: 'done',
      toolUse: {
        id: 'tool-1',
        name: 'Bash',
        input: { command: `echo ${rawSentinel}` },
        output: `stdout ${rawSentinel}`,
      },
    });
    addEvent({
      type: 'runner_call_artifact',
      ts: 1_070,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 4,
      artifact: {
        id: 'artifact-1',
        source: 'tool',
        name: 'result.txt',
        path: `/tmp/${rawSentinel}.txt`,
        mimeType: 'text/plain',
        text: `artifact ${rawSentinel}`,
      },
    });
    addEvent(
      makeRunnerWarning({
        warning: {
          code: 'provider_warning',
          message: `warning ${rawSentinel}`,
          surface: 'activity',
        },
      }),
    );
    addEvent({
      type: 'runner_call_session_id',
      ts: 1_080,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 5,
      nativeSessionId: `native-${rawSentinel}`,
    });
    addEvent(
      makeRunnerActivity({
        kind: 'session',
        activityId: 'call-1:session',
        label: `session ${rawSentinel}`,
        target: `native-${rawSentinel}`,
        diagnosticPartial: 'safe diagnostic',
        rawAvailable: true,
        expandId: `raw-${rawSentinel}`,
      }),
    );
    addEvent(makeRunnerError({ error: { code: 'failed', message: `failed ${rawSentinel}` } }));

    const events = eventsStore.get().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'runner_call_activity',
      label: 'session captured',
      redacted: false,
    });
    expect(events[0]).not.toHaveProperty('target');
    expect(events[0]).not.toHaveProperty('diagnosticPartial');
    expect(events[0]).not.toHaveProperty('rawAvailable');
    expect(events[0]).not.toHaveProperty('expandId');
    expect(JSON.stringify(events)).not.toContain(rawSentinel);

    expect(operationsStore.get().last).toMatchObject({
      callId: 'call-1',
      status: 'failed',
      usage: { inputTokens: 1, outputTokens: 2 },
      reason: `failed ${rawSentinel}`,
    });
  });

  it('sanitizes generic warning and error messages before retaining them', () => {
    const secret = 'sk-abcdefghijklmnopqrst';

    addEvent({
      type: 'warning',
      ts: 1_000,
      phase: 'planning',
      message: `warn ${secret}\u001b]0;owned\u0007`,
    });
    addEvent({
      type: 'error',
      ts: 1_001,
      phase: 'planning',
      message: `err ${secret}\u001b[31m`,
    });

    expect(eventsStore.get().events).toEqual([
      {
        type: 'warning',
        ts: 1_000,
        phase: 'planning',
        message: 'warn sk-***REDACTED***',
      },
      {
        type: 'error',
        ts: 1_001,
        phase: 'planning',
        message: 'err sk-***REDACTED***',
      },
    ]);
  });

  it('retains an already-protected external-change event without re-processing', () => {
    const protectedEvent = protectEngineEventForConsumer(
      {
        type: 'paused_external_changes',
        ts: 1_002,
        phase: 'implementing',
        selectedAction: 'pause',
        conflict: {
          kind: 'current-task-conflict',
          files: [TRANSCRIPT_OMITTED_MESSAGE],
          affectedTaskIds: [taskId('T001')],
          currentTaskId: taskId('T001'),
          fileConflicts: [
            {
              file: TRANSCRIPT_OMITTED_MESSAGE,
              kind: 'current-task-conflict',
              affectedTaskIds: [taskId('T001')],
            },
          ],
          safeToContinue: false,
          availableActions: ['pause', 'skip-current-task', 'abort-workflow'],
        },
      },
      { context: 'ipc', persistTranscript: false },
    );
    if (protectedEvent?.type !== 'paused_external_changes') {
      throw new Error('Expected protected paused_external_changes event');
    }

    addEvent(protectedEvent);

    expect(eventsStore.get().events).toEqual([protectedEvent]);
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
      addEvent(
        makeValidate({
          status: 'running',
          passed: false,
          stages: { typecheck: false, lint: false, test: false },
        }),
      );
      addEvent(
        makeValidate({
          status: 'running',
          passed: false,
          stages: { typecheck: true, lint: false, test: false },
        }),
      );
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect((events[0] as { stages: { typecheck: boolean } }).stages.typecheck).toBe(true);
    });

    it('does not replace done validate with running', () => {
      addEvent(
        makeValidate({
          status: 'done',
          passed: true,
          stages: { typecheck: true, lint: true, test: true },
        }),
      );
      addEvent(
        makeValidate({
          status: 'running',
          passed: false,
          stages: { typecheck: false, lint: false, test: false },
        }),
      );
      expect(eventsStore.get().events).toHaveLength(2);
    });
  });

  describe('validation_baseline coalescing', () => {
    it('collapses two consecutive running events to one entry', () => {
      addEvent(
        makeValidationBaseline({
          status: 'running',
          stages: { typecheck: false, lint: false, test: false },
          activeStage: 'typecheck',
        }),
      );
      addEvent(
        makeValidationBaseline({
          status: 'running',
          stages: { typecheck: true, lint: false, test: false },
          activeStage: 'lint',
        }),
      );
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect((events[0] as { activeStage: string }).activeStage).toBe('lint');
    });

    it('does not collapse a running event followed by a done event', () => {
      addEvent(
        makeValidationBaseline({
          status: 'running',
          stages: { typecheck: false, lint: false, test: false },
        }),
      );
      addEvent(
        makeValidationBaseline({
          status: 'done',
          stages: { typecheck: true, lint: true, test: true },
        }),
      );
      expect(eventsStore.get().events).toHaveLength(2);
    });
  });

  it('mergeEvent caps text and keeps most recent content', () => {
    const base = [makePlannerText({ text: 'a'.repeat(MAX_MERGED_TEXT_LENGTH) })];
    const result = mergeEvent(base, makePlannerText({ text: 'RECENT' }));
    const text = (result[0] as { text: string }).text;
    expect(text.length).toBe(MAX_MERGED_TEXT_LENGTH);
    expect(text.endsWith('RECENT')).toBe(true);
  });

  it('does not merge planner_text across differing roles so implementer output stays separate', () => {
    const base = [makePlannerText({ text: 'planner thinking' })];
    const result = mergeEvent(
      base,
      makePlannerText({ text: 'implementer writing', role: 'implementer' }),
    );
    expect(result).toHaveLength(2);
    expect((result[0] as { text: string }).text).toBe('planner thinking');
    expect(result[1]).toMatchObject({ text: 'implementer writing', role: 'implementer' });
  });

  it('does not merge planner_text across differing content formats', () => {
    const base = [makePlannerText({ text: 'plain log' })];
    const result = mergeEvent(base, makePlannerText({ text: '### Plan', content: 'markdown' }));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ text: 'plain log' });
    expect(result[1]).toMatchObject({ text: '### Plan', content: 'markdown' });
  });

  describe('planner_heartbeat coalescing', () => {
    it('drops heartbeats from the retained event log', () => {
      addEvent({
        type: 'planner_heartbeat',
        ts: 1000,
        phase: 'planning',
        elapsedMs: 5000,
        accumulatedTokens: 100,
      });
      addEvent({
        type: 'planner_heartbeat',
        ts: 3000,
        phase: 'planning',
        elapsedMs: 7000,
        accumulatedTokens: 200,
      });
      expect(eventsStore.get().events).toHaveLength(0);
    });

    it('does not split visible rows around a heartbeat', () => {
      addEvent(makePlannerText({ text: 'a' }));
      addEvent({
        type: 'planner_heartbeat',
        ts: 1000,
        phase: 'planning',
        elapsedMs: 5000,
        accumulatedTokens: 100,
      });
      addEvent(makePlannerText({ text: 'b' }));
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect((events[0] as { text: string }).text).toBe('ab');
    });
  });
});

describe('projectEventForTuiEventLog', () => {
  it('drops runner_call_stalled and runner_call_stall_cleared', () => {
    expect(
      projectEventForTuiEventLog({
        type: 'runner_call_stalled',
        ts: 1000,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 1,
        silentMs: 60_000,
      }),
    ).toBeNull();
    expect(
      projectEventForTuiEventLog({
        type: 'runner_call_stall_cleared',
        ts: 2000,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 2,
      }),
    ).toBeNull();
  });
});
