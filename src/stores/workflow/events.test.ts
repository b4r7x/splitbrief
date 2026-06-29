import { describe, it, expect, beforeEach } from 'vitest';
import { eventsStore, MAX_EVENTS, MAX_MERGED_TEXT_LENGTH, mergeEvent } from './events.js';
import { addEvent, resetWorkflow } from './actions.js';
import { taskId } from '../../core/schemas/task.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import { protectEngineEventForConsumer } from '../../engine/events/protection.js';
import type { RunnerCallWarningInput } from '../../engine/calls/types.js';
import { normalizeRunnerCallWarning } from '../../engine/calls/warnings.js';
import {
  makePlannerText,
  makePlannerStatus,
  makeTaskStart,
  makeValidate,
  makeRetry,
  makeCostUpdate,
} from '#testing/helpers/events.js';
import { operationsStore } from './operations.js';

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
  return {
    type: 'runner_call_activity',
    ts: 1_200,
    phase: 'implementing',
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 3,
    activityId: 'call-1:tool:1',
    stage: 'completed',
    kind: 'command',
    label: 'running npm test',
    target: 'npm test',
    redacted: false,
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
    expect(s.events[0]).toBe(event);
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

  it('retains protected external-change conflict metadata without raw file paths', () => {
    const rawPath = 'src/private-store-conflict.ts';
    const protectedEvent = protectEngineEventForConsumer(
      {
        type: 'paused_external_changes',
        ts: 1_002,
        phase: 'implementing',
        selectedAction: 'pause',
        conflict: {
          kind: 'current-task-conflict',
          files: [rawPath],
          affectedTaskIds: [taskId('T001')],
          currentTaskId: taskId('T001'),
          fileConflicts: [
            {
              file: rawPath,
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

    expect(eventsStore.get().events).toEqual([
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
    ]);
    expect(JSON.stringify(eventsStore.get().events)).not.toContain(rawPath);
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

  it('caps merged planner_text at MAX_MERGED_TEXT_LENGTH', () => {
    const bigChunk = 'x'.repeat(MAX_MERGED_TEXT_LENGTH);
    addEvent(makePlannerText({ text: bigChunk }));
    addEvent(makePlannerText({ text: 'tail' }));
    const s = eventsStore.get();
    expect(s.events).toHaveLength(1);
    const text = (s.events[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_MERGED_TEXT_LENGTH);
    expect(text.endsWith('tail')).toBe(true);
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
    it('replaces consecutive heartbeat with the latest', () => {
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
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      const hb = events[0] as { type: string; elapsedMs: number; accumulatedTokens: number };
      expect(hb.elapsedMs).toBe(7000);
      expect(hb.accumulatedTokens).toBe(200);
    });

    it('does not replace heartbeat when a different event type intervenes', () => {
      addEvent({
        type: 'planner_heartbeat',
        ts: 1000,
        phase: 'planning',
        elapsedMs: 5000,
        accumulatedTokens: 100,
      });
      addEvent(makePlannerText({ text: 'thinking' }));
      addEvent({
        type: 'planner_heartbeat',
        ts: 3000,
        phase: 'planning',
        elapsedMs: 7000,
        accumulatedTokens: 200,
      });
      expect(eventsStore.get().events).toHaveLength(3);
    });
  });
});
