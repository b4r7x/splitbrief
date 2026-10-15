import { describe, it, expect, beforeEach } from 'vitest';
import {
  eventsStore,
  MAX_EVENTS,
  MAX_MERGED_TEXT_LENGTH,
  mergeEvent,
  mergeEventLog,
  projectEventForTuiEventLog,
} from './events.js';
import { addEvent } from './actions/event.js';
import { resetWorkflow } from './actions/reset.js';
import { markCancellationRequested } from './actions/interrupt.js';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import { parseEngineEvent } from '../../engine/events/schema.js';
import type { RunnerCallWarningInput } from '../../engine/calls/types.js';
import { normalizeRunnerCallWarning } from '../../engine/calls/warnings.js';
import { makePlannerText, makePlannerStatus } from '#testing/helpers/events/planner.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallHeartbeat,
} from '#testing/helpers/events/runner-call.js';
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

function makeFullSuite(
  overrides?: Partial<EngineEventOf<'full_suite'>>,
): EngineEventOf<'full_suite'> {
  return {
    type: 'full_suite',
    ts: Date.now(),
    phase: 'implementing',
    status: 'running',
    stage: 'test',
    command: 'npm test',
    moment: 'pre-review',
    ...overrides,
  };
}

describe('eventsStore — append via addEvent', () => {
  beforeEach(() => resetWorkflow());

  it('settles a crash-cut reviewer check at resume before a later attempt runs the same check', () => {
    const started = makeFullSuite({ ts: 4_000, phase: 'final-review', id: 'V1' });
    const resumed: EngineEvent = { type: 'workflow_resumed', ts: 65_000, phase: 'final-review' };
    const restarted = { ...started, ts: 66_000 };
    const completed = {
      ...restarted,
      ts: 70_000,
      status: 'done',
      passed: true,
      duration: 4_000,
    } satisfies EngineEventOf<'full_suite'>;
    const events = [started, resumed, restarted, completed];
    const expected = [{ ...started, status: 'stopped' }, resumed, completed];
    for (const event of events) addEvent(event);
    expect(eventsStore.get().events).toEqual(expected);
    expect(mergeEventLog(events)).toEqual(expected);
    expect(started.status).toBe('running');
  });

  it.each(['failed', 'cancelled'] as const)(
    'keeps the %s call outcome in operations, outside the activity batch input',
    (status) => {
      addEvent(makeRunnerStarted());
      addEvent(makeRunnerActivity({ kind: 'read', stage: 'completed', label: 'reading file.ts' }));
      if (status === 'failed') addEvent(makeRunnerError());
      else addEvent({ type: 'workflow_cancelled', ts: 2_000, phase: 'implementing' });

      expect(operationsStore.get().byCallId.get('call-1')?.status).toBe(status);
      expect(eventsStore.get().events.map((event) => event.type)).toEqual(
        status === 'failed'
          ? ['runner_call_activity']
          : ['runner_call_activity', 'workflow_cancelled'],
      );
      expect(eventsStore.get().events[0]).toMatchObject({ kind: 'read', stage: 'completed' });
    },
  );

  // A run reopened at rest shows its cut call closed as interrupted, read off its log; continuing
  // it records that same close on the bus. The transcript states the close once.
  it('keeps one close of a cut call when the resume records the close the screen already read', () => {
    const cut = makeRunnerCallActivity({
      callId: 'implementer-2',
      ts: 45,
      activityId: 'implementer-2:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'SPLITBRIEF exited',
    });
    addEvent(cut);
    addEvent({ ...cut });
    expect(
      eventsStore.get().events.filter((event) => event.type === 'runner_call_activity'),
    ).toHaveLength(1);

    // Call ids restart with each process: the next process's close of a reused id is its own.
    addEvent({ type: 'workflow_resumed', ts: 60, phase: 'implementing' });
    addEvent({ ...cut });
    expect(
      eventsStore.get().events.filter((event) => event.type === 'runner_call_activity'),
    ).toHaveLength(2);
  });

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

  it('keeps marked implementer messages separate while joining their token chunks', () => {
    const chunks = [
      makePlannerText({ role: 'implementer', text: 'First ' }),
      makePlannerText({ role: 'implementer', text: 'message.' }),
      makePlannerText({ role: 'implementer', text: 'Second ', messageStart: true }),
      makePlannerText({ role: 'implementer', text: 'message.' }),
    ];
    for (const chunk of chunks) addEvent(chunk);

    const live = eventsStore.get().events;
    expect(live.map((event) => (event.type === 'planner_text' ? event.text : ''))).toEqual([
      'First message.',
      'Second message.',
    ]);
    expect(mergeEventLog(chunks)).toEqual(live);
  });

  it('keeps legacy and extracted-code chunks joined without a boundary marker', () => {
    const old = makePlannerText({ role: 'implementer', text: 'export const ' });
    const next = makePlannerText({ role: 'implementer', text: 'value = 1;' });
    expect(parseEngineEvent(old)).toMatchObject(old);
    expect(parseEngineEvent({ ...next, messageStart: true })).toMatchObject({
      ...next,
      messageStart: true,
    });
    expect(mergeEventLog([old, next])).toMatchObject([{ text: 'export const value = 1;' }]);
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
    expect(events).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(rawSentinel);

    expect(operationsStore.get().last).toMatchObject({
      callId: 'call-1',
      status: 'failed',
      usage: { inputTokens: 1, outputTokens: 2 },
      reason: `failed ${rawSentinel}`,
    });
  });

  it('sanitizes generic info, warning and error messages before retaining them', () => {
    const secret = 'sk-abcdefghijklmnopqrst';

    addEvent({
      type: 'info',
      ts: 999,
      phase: 'planning',
      message: `info ${secret}\u001b[31m`,
    });
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
        type: 'info',
        ts: 999,
        phase: 'planning',
        message: 'info sk-***REDACTED***',
      },
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

  it('keeps recorded axes through live and replay activity projection and sanitizes each word', () => {
    const event = makeRunnerActivity({ axes: ['high', '\u001b[31mthinking\u001b[0m'] });
    const expected = expect.objectContaining({ axes: ['high', 'thinking'], redacted: true });
    addEvent(event);
    expect(eventsStore.get().events).toEqual([expected]);
    expect(mergeEventLog([event])).toEqual([expected]);
  });

  it('keeps raw warning model ids through the activity projection and sanitizes them', () => {
    const warningRow = {
      kind: 'warning',
      label: 'warning claude_fallback',
      diagnosticPartial: 'claude-opus-5-5 → claude-sonnet-5 (overloaded)',
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5',
    } as const;
    addEvent(makeRunnerActivity({ ...warningRow }));
    addEvent(
      makeRunnerActivity({
        ...warningRow,
        activityId: 'call-1:warning:2',
        sequence: 4,
        originalModel: 'claude-opus-5-5\u001b[31m',
      }),
    );

    const events = eventsStore.get().events;
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'runner_call_activity',
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5',
      redacted: false,
    });
    // A control character in an added string is stripped and marks the row for the raw surface.
    expect(events[1]).toMatchObject({
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5',
      redacted: true,
    });
    expect(JSON.stringify(events)).not.toContain('\u001b');
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

    it('replaces the running validate of a brief with its settled verdict', () => {
      addEvent(makeValidate({ taskId: taskId('T001'), status: 'running', passed: false }));
      addEvent(makeValidate({ taskId: taskId('T001'), status: 'done', passed: true }));
      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'done', passed: true });
    });

    it('keeps the running validate of another brief', () => {
      addEvent(makeValidate({ taskId: taskId('T001'), status: 'running', passed: false }));
      addEvent(makeValidate({ taskId: taskId('T002'), status: 'done', passed: true }));
      expect(eventsStore.get().events).toHaveLength(2);
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

  describe('full_suite coalescing', () => {
    it('replays 40k alternating running and done command events into capped settled rows', () => {
      const log = Array.from({ length: 40_000 }, (_, index) =>
        makeFullSuite({
          ts: index,
          status: index % 2 === 0 ? 'running' : 'done',
          passed: index % 2 !== 0,
        }),
      );

      const events = mergeEventLog(log);

      expect(events).toHaveLength(MAX_EVENTS);
      expect(events.every((event) => event.type === 'full_suite' && event.status === 'done')).toBe(
        true,
      );
      expect(events[0]?.ts).toBe(20_001);
      expect(events.at(-1)?.ts).toBe(39_999);
    });

    it.each([
      ['full_suite', makeFullSuite({ id: 'K1', moment: 'plan', ts: 1_000 })],
      ['validate', makeValidate({ taskId: taskId('T001'), status: 'running', ts: 1_000 })],
    ] as const)('settles %s across a warning before Stop in live and replay logs', (_, running) => {
      const done: EngineEvent = { ...running, status: 'done', passed: true, ts: 2_000 };
      const warning: EngineEvent = {
        type: 'warning',
        ts: 1_500,
        phase: running.phase,
        message: 'The test pattern was refused.',
      };
      const stop: EngineEvent = { type: 'turn_interrupted', ts: 3_000, phase: running.phase };
      const log: EngineEvent[] = [running, warning, done, stop];
      for (const event of log) addEvent(event);
      const expected = [done, warning, stop];
      expect(eventsStore.get().events).toEqual(expected);
      expect(log.reduce(mergeEvent, [])).toEqual(expected);
      expect(mergeEventLog(log)).toEqual(expected);
      expect(running.status).toBe('running');
    });

    it('keeps one gate row as running stages update across a warning', () => {
      const gate = makeValidate({ taskId: taskId('T001'), status: 'running', ts: 1_000 });
      const done = { ...gate, status: 'done' as const, passed: true, ts: 3_000 };
      const warning: EngineEvent = {
        type: 'warning',
        ts: 1_500,
        phase: gate.phase,
        message: 'The test pattern was refused.',
      };
      const stop: EngineEvent = { type: 'turn_interrupted', ts: 4_000, phase: gate.phase };
      const log: EngineEvent[] = [
        gate,
        warning,
        { ...gate, activeStage: 'test', ts: 2_000 },
        done,
        stop,
      ];
      expect(log.reduce(mergeEvent, [])).toEqual([done, warning, stop]);
      expect(mergeEventLog(log)).toEqual([done, warning, stop]);
    });

    it('merges each plan render into its own settled row', () => {
      for (const id of ['R1', 'R2']) {
        const render = makeFullSuite({ id, moment: 'plan', scenario: `workflow-${id}` });
        addEvent(render);
        addEvent({ ...render, status: 'done', passed: true, duration: 14_200 });
      }
      expect(eventsStore.get().events).toHaveLength(2);
      expect(eventsStore.get().events).toEqual([
        expect.objectContaining({ id: 'R1', status: 'done' }),
        expect.objectContaining({ id: 'R2', status: 'done' }),
      ]);
    });

    it.each(['turn_interrupted', 'workflow_cancelled'] as const)(
      '%s settles every unfinished command in live and batch logs, preserving settled checks',
      (type) => {
        const settled = makeFullSuite({ id: 'V1', moment: 'brief', status: 'running', ts: 1_000 });
        const fix = makeFullSuite({ id: 'V2', moment: 'brief', ts: 3_000 });
        const render = makeFullSuite({
          id: 'R1',
          moment: 'plan',
          scenario: 'workflow-x',
          ts: 4_000,
        });
        const gate = makeValidate({ status: 'running', activeStage: 'test', ts: 5_000 });
        const log = [
          settled,
          makePlannerText({ ts: 1_100 }),
          { ...settled, status: 'done' as const, passed: false, ts: 2_000 },
          fix,
          render,
          gate,
          { type, ts: 6_000, phase: 'implementing' as const },
        ];
        for (const event of log) addEvent(event);
        const live = eventsStore.get().events;
        expect(live).toEqual(mergeEventLog(log));
        expect(live).toContainEqual({ ...fix, status: 'stopped' });
        expect(live).toContainEqual({ ...render, status: 'stopped' });
        expect(live).toContainEqual({ ...gate, status: 'stopped' });
        expect(live[0]).toEqual({ ...settled, status: 'done', passed: false, ts: 2_000 });
        expect(fix.status).toBe('running');
        expect(render.status).toBe('running');
      },
    );

    it('accepts the durable interruption after local stop intent to settle the transcript', () => {
      const fix = makeFullSuite({ id: 'V1', moment: 'brief', ts: 1_000 });
      addEvent(fix);
      markCancellationRequested({ ts: 2_000 });
      addEvent({ type: 'turn_interrupted', ts: 3_000, phase: 'implementing' });
      expect(eventsStore.get().events[0]).toEqual({ ...fix, status: 'stopped' });
    });

    it('replaces a running stage entry with its settled verdict', () => {
      addEvent(makeFullSuite({ status: 'running' }));
      addEvent(makeFullSuite({ status: 'done', passed: true, duration: 12_000 }));

      const events = eventsStore.get().events;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'full_suite', status: 'done', passed: true });
    });

    it('keeps one row per stage run', () => {
      addEvent(makeFullSuite({ stage: 'typecheck', command: 'tsc --noEmit' }));
      addEvent(
        makeFullSuite({
          stage: 'typecheck',
          command: 'tsc --noEmit',
          status: 'done',
          passed: true,
        }),
      );
      addEvent(makeFullSuite({ stage: 'test', command: 'npm test' }));
      addEvent(makeFullSuite({ stage: 'test', command: 'npm test', status: 'done', passed: true }));

      const events = eventsStore.get().events;
      expect(events).toHaveLength(2);
      expect(events.map((event) => (event as { stage: string }).stage)).toEqual([
        'typecheck',
        'test',
      ]);
    });

    it('keys a reviewer check by its id: V1 settles in place, V2 gets a row of its own', () => {
      const check = (overrides: Partial<EngineEventOf<'full_suite'>>) =>
        makeFullSuite({ stage: undefined, phase: 'final-review', ...overrides });
      addEvent(check({ id: 'V1', command: 'tsc --noEmit' }));
      addEvent(check({ id: 'V2', command: 'npm test' }));
      addEvent(check({ id: 'V2', command: 'npm test', status: 'done', passed: false }));

      const events = eventsStore.get().events;
      expect(events).toHaveLength(2);
      expect(
        events.map((event) => (event.type === 'full_suite' ? [event.id, event.status] : [])),
      ).toEqual([
        ['V1', 'running'],
        ['V2', 'done'],
      ]);
    });

    it('keeps the base re-run of a settled check as a row of its own', () => {
      const check = (overrides: Partial<EngineEventOf<'full_suite'>>) =>
        makeFullSuite({ stage: undefined, phase: 'final-review', id: 'V1', ...overrides });
      addEvent(check({ status: 'running' }));
      addEvent(check({ status: 'done', passed: false }));
      addEvent(check({ status: 'running', moment: 'base' }));
      addEvent(check({ status: 'done', moment: 'base', passed: false }));

      const events = eventsStore.get().events;
      expect(
        events.map((event) => (event.type === 'full_suite' ? [event.moment, event.status] : [])),
      ).toEqual([
        ['pre-review', 'done'],
        ['base', 'done'],
      ]);
    });

    it('keeps a running check and its running base re-run as two rows when no verdict lands between', () => {
      const check = (overrides: Partial<EngineEventOf<'full_suite'>>) =>
        makeFullSuite({ stage: undefined, phase: 'final-review', id: 'V1', ...overrides });
      addEvent(check({ status: 'running' }));
      addEvent(check({ status: 'running', moment: 'base' }));

      const events = eventsStore.get().events;
      expect(
        events.map((event) => (event.type === 'full_suite' ? [event.moment, event.status] : [])),
      ).toEqual([
        ['pre-review', 'running'],
        ['base', 'running'],
      ]);
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
      });
      addEvent({
        type: 'planner_heartbeat',
        ts: 3000,
        phase: 'planning',
        elapsedMs: 7000,
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

  it('drops runner_call_heartbeat, which only moves the freshness clock', () => {
    expect(projectEventForTuiEventLog(makeRunnerCallHeartbeat())).toBeNull();
  });
});
