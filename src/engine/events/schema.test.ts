import { describe, expect, it } from 'vitest';
import { parseEngineEvent } from './schema.js';
import type { EngineEvent } from './types.js';

describe('EngineEvent alias colocation with EngineEventSchema', () => {
  it('parseEngineEvent (schema.ts) yields a value usable as the EngineEvent alias (types.ts)', () => {
    const parsed = parseEngineEvent({
      type: 'workflow_started',
      ts: 7,
      phase: 'idle',
      feature: 'demo',
    });
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    const event: EngineEvent = parsed;
    expect(event.type).toBe('workflow_started');
    expect(event.ts).toBe(7);
  });

  it('round-trips a discriminated variant through the schema without losing fields', () => {
    const input = {
      type: 'task_completed' as const,
      ts: 3,
      phase: 'implementing' as const,
      taskId: 'T001',
      title: 'Finish task',
      method: 'local' as const,
      retries: 0,
      duration: 10,
    };
    const parsed = parseEngineEvent(input);
    expect(parsed).toEqual(expect.objectContaining(input));
  });
});

describe('parseEngineEvent', () => {
  it.each([
    ['all', 'plan'],
    ['spec', 'plan'],
    ['default', 'plan'],
    ['none', 'none'],
  ])('replays an old mode_resolved line with approve %s as %s', (saved, loaded) => {
    const parsed = parseEngineEvent({
      type: 'mode_resolved',
      ts: 1,
      phase: 'researching',
      mode: 'standard',
      approve: saved,
    });
    expect(parsed).toMatchObject({ type: 'mode_resolved', approve: loaded });
  });

  it('pins the type-level contract for operational message safety metadata', () => {
    const complete = {
      type: 'warning',
      ts: 1,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      category: 'queue',
      code: 'queue_full',
    } satisfies EngineEvent;

    const partial = {
      type: 'warning',
      ts: 1,
      phase: 'implementing',
      message: 'Queue full (50 messages).',
      category: 'queue',
    };
    // @ts-expect-error operational message safety metadata is all-or-nothing
    const invalid: EngineEvent = partial;

    expect(parseEngineEvent(complete)).toMatchObject({ category: 'queue', code: 'queue_full' });
    expect(parseEngineEvent(invalid)).toBeNull();
  });

  it('accepts explicit cache fields on task token events', () => {
    expect(
      parseEngineEvent({
        type: 'task_tokens',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        method: 'local',
        implementerTokens: 0,
        escalationTokens: 0,
        implementerCacheReadTokens: 1_000_000,
        implementerCacheCreateTokens: 0,
        escalationCacheReadTokens: 0,
        escalationCacheCreateTokens: 0,
        retryCount: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'task_tokens',
        implementerCacheReadTokens: 1_000_000,
      }),
    );
  });

  it('rejects negative cache fields on task token events', () => {
    expect(
      parseEngineEvent({
        type: 'task_tokens',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        method: 'local',
        implementerTokens: 0,
        escalationTokens: 0,
        implementerCacheReadTokens: -1,
        retryCount: 0,
      }),
    ).toBeNull();
  });

  it('rejects unknown event types', () => {
    expect(parseEngineEvent({ type: 'not_real', ts: 1, phase: 'idle' })).toBeNull();
  });

  it('rejects known events missing required variant fields', () => {
    expect(parseEngineEvent({ type: 'task_completed', ts: 1, phase: 'implementing' })).toBeNull();
  });

  it('preserves unknown keys on parsed events', () => {
    const parsed = parseEngineEvent({
      type: 'workflow_started',
      ts: 1,
      phase: 'idle',
      feature: 'demo',
      forwardCompatField: { nested: true },
    });
    expect(parsed).toMatchObject({ forwardCompatField: { nested: true } });
  });

  it('replays a rewind event an older run logged', () => {
    const event = {
      type: 'rewind_to_plan',
      ts: 1,
      phase: 'implementing',
      comment: 'split up the tasks',
    } as const;

    expect(parseEngineEvent(event)).toEqual(expect.objectContaining(event));
  });

  it('accepts only the canonical workflow cancellation reason when present', () => {
    expect(
      parseEngineEvent({
        type: 'workflow_cancelled',
        ts: 1,
        phase: 'implementing',
      }),
    ).toEqual(expect.objectContaining({ type: 'workflow_cancelled' }));
    expect(
      parseEngineEvent({
        type: 'workflow_cancelled',
        ts: 1,
        phase: 'implementing',
        reason: 'user_cancelled',
      }),
    ).toEqual(expect.objectContaining({ reason: 'user_cancelled' }));
    expect(
      parseEngineEvent({
        type: 'workflow_cancelled',
        ts: 1,
        phase: 'implementing',
        reason: 'ctrl_c',
      }),
    ).toBeNull();
  });

  it('keeps runner call terminal variants type-safe', () => {
    const base = {
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      sequence: 0,
      startedAt: 1,
      endedAt: 11,
      durationMs: 10,
      partial: false,
      usage: null,
      nativeSessionId: null,
    } as const;

    expect(
      parseEngineEvent({
        type: 'runner_call_completed',
        ...base,
        status: 'completed',
        error: null,
      }),
    ).toEqual(expect.objectContaining({ type: 'runner_call_completed' }));
    expect(
      parseEngineEvent({
        type: 'runner_call_completed',
        ...base,
        status: 'failed',
        error: null,
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        type: 'runner_call_error',
        ...base,
        status: 'timeout',
        partial: true,
        error: { code: 'timeout', message: 'timed out' },
      }),
    ).toEqual(expect.objectContaining({ type: 'runner_call_error' }));
    expect(
      parseEngineEvent({
        type: 'runner_call_error',
        ...base,
        status: 'completed',
        error: { code: 'bad', message: 'bad' },
      }),
    ).toBeNull();
  });

  it('accepts runner text deltas with their source channel', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'assistant',
        text: 'assistant output',
        semantics: 'final',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'assistant',
        semantics: 'final',
      }),
    );
  });

  it('accepts legacy runner text deltas without semantics', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'assistant',
        text: 'assistant output',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'assistant',
        text: 'assistant output',
      }),
    );
  });

  it('rejects runner text deltas without a channel', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        text: 'output',
      }),
    ).toBeNull();
  });

  it('parses runner tool-use events by lifecycle stage', () => {
    const base = {
      type: 'runner_call_tool_use',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    } as const;

    expect(
      parseEngineEvent({
        ...base,
        stage: 'delta',
        toolUseId: null,
        name: 'Bash',
        inputDelta: '{"command":"npm',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_tool_use',
        stage: 'delta',
      }),
    );
    expect(
      parseEngineEvent({
        ...base,
        stage: 'done',
        toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_tool_use',
        stage: 'done',
      }),
    );
    expect(
      parseEngineEvent({
        ...base,
        toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...base,
        name: 'Bash',
        inputDelta: '{"command":"npm',
      }),
    ).toBeNull();
    expect(
      parseEngineEvent({
        ...base,
        stage: 'started',
        toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
      }),
    ).toBeNull();
  });

  it('rejects runner tool-use stages without their stage payload', () => {
    const base = {
      type: 'runner_call_tool_use',
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    } as const;

    expect(parseEngineEvent({ ...base, stage: 'done' })).toBeNull();
    expect(parseEngineEvent({ ...base, stage: 'delta', toolUseId: null, name: 'Bash' })).toBeNull();
  });

  it('accepts safe runner activity events', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_activity',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        activityId: 'call-1:tool:tool-1',
        stage: 'completed',
        kind: 'command',
        label: 'running npm test',
        target: 'npm test',
        redacted: false,
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_activity',
        kind: 'command',
        label: 'running npm test',
      }),
    );
  });

  it('accepts planner heartbeat events with a runner call id', () => {
    expect(
      parseEngineEvent({
        type: 'planner_heartbeat',
        ts: 1,
        phase: 'planning',
        elapsedMs: 5000,
        callId: 'planner-call-1',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'planner_heartbeat',
        callId: 'planner-call-1',
      }),
    );
  });

  it('still reads an old planner heartbeat that carried a token count', () => {
    expect(
      parseEngineEvent({
        type: 'planner_heartbeat',
        ts: 1,
        phase: 'planning',
        elapsedMs: 5000,
        accumulatedTokens: 0,
      }),
    ).toEqual(expect.objectContaining({ type: 'planner_heartbeat', elapsedMs: 5000 }));
  });

  it('accepts validate events with active stage command metadata', () => {
    expect(
      parseEngineEvent({
        type: 'validate',
        ts: 1,
        phase: 'validating-task',
        taskId: 'T001',
        status: 'running',
        passed: false,
        stages: { typecheck: false, lint: false, test: false },
        attempted: { typecheck: false, lint: false, test: false },
        activeStage: 'typecheck',
        commands: { typecheck: 'npm run typecheck' },
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'validate',
        activeStage: 'typecheck',
        commands: { typecheck: 'npm run typecheck' },
      }),
    );
  });

  it('accepts a full_suite running event with its stage, command and moment', () => {
    expect(
      parseEngineEvent({
        type: 'full_suite',
        ts: 1,
        phase: 'implementing',
        status: 'running',
        stage: 'test',
        command: 'npm test',
        moment: 'pre-review',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'full_suite',
        status: 'running',
        stage: 'test',
        command: 'npm test',
        moment: 'pre-review',
      }),
    );
  });

  it('accepts a full_suite done event and rejects an unknown moment', () => {
    expect(
      parseEngineEvent({
        type: 'full_suite',
        ts: 1,
        phase: 'implementing',
        status: 'done',
        stage: 'lint',
        command: 'npm run lint',
        moment: 'pre-review',
        passed: false,
        duration: 1_200,
      }),
    ).toEqual(expect.objectContaining({ type: 'full_suite', passed: false, duration: 1_200 }));
    expect(
      parseEngineEvent({
        type: 'full_suite',
        ts: 1,
        phase: 'implementing',
        status: 'done',
        stage: 'lint',
        command: 'npm run lint',
        moment: 'whenever',
      }),
    ).toBeNull();
  });

  it('accepts queued message events with preview text', () => {
    expect(
      parseEngineEvent({
        type: 'message_queued',
        ts: 1,
        phase: 'planning',
        id: 'msg-1',
        preview: 'pending preview',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'message_queued',
        id: 'msg-1',
        preview: 'pending preview',
      }),
    );
  });

  it('accepts queued message events tagged with a clarification origin', () => {
    expect(
      parseEngineEvent({
        type: 'message_queued',
        ts: 1,
        phase: 'specifying',
        id: 'msg-2',
        origin: 'clarification',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'message_queued',
        id: 'msg-2',
        origin: 'clarification',
      }),
    );
  });

  it('turn_interrupted parses with and without source', () => {
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'implementing',
      }),
    ).toEqual(expect.objectContaining({ type: 'turn_interrupted' }));
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'implementing',
        source: 'watchdog',
      }),
    ).toEqual(expect.objectContaining({ type: 'turn_interrupted', source: 'watchdog' }));
  });

  it('turn_interrupted carries where the stop landed', () => {
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'implementing',
        source: 'user',
        at: 'boundary',
      }),
    ).toEqual(expect.objectContaining({ type: 'turn_interrupted', at: 'boundary' }));
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'implementing',
        at: 'somewhere-else',
      }),
    ).toBeNull();
  });

  it('turn_interrupted names the step the stop parked, and refuses one that is not a step', () => {
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'reviewing-plan',
        source: 'user',
        at: 'boundary',
        step: { kind: 'gate', gate: 'plan' },
      }),
    ).toEqual(expect.objectContaining({ step: { kind: 'gate', gate: 'plan' } }));
    expect(
      parseEngineEvent({
        type: 'turn_interrupted',
        ts: 1,
        phase: 'reviewing-plan',
        step: { kind: 'gate', gate: 'nowhere' },
      }),
    ).toBeNull();
  });

  it('runner_call_stalled requires silentMs and runner_call_stall_cleared parses', () => {
    const base = {
      ts: 1,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      sequence: 0,
    } as const;

    expect(
      parseEngineEvent({
        type: 'runner_call_stalled',
        ...base,
        silentMs: 60_000,
      }),
    ).toEqual(expect.objectContaining({ type: 'runner_call_stalled', silentMs: 60_000 }));
    expect(parseEngineEvent({ type: 'runner_call_stalled', ...base })).toBeNull();
    expect(parseEngineEvent({ type: 'runner_call_stall_cleared', ...base })).toEqual(
      expect.objectContaining({ type: 'runner_call_stall_cleared' }),
    );
  });

  it.each([
    { type: 'brief_quality_passed', score: 0.9, warningCount: 0 },
    { type: 'brief_quality_failed', score: 0.4, errorCount: 2, warningCount: 1 },
    { type: 'brief_readiness_passed', taskCount: 4 },
    {
      type: 'brief_readiness_blocked',
      taskCount: 4,
      blockedCount: 1,
      blockedTaskIds: ['T001'],
      kinds: ['stale-conflict'],
    },
  ])('reads an old $type event as no event', (event) => {
    expect(parseEngineEvent({ ...event, ts: 1, phase: 'reviewing-briefs' })).toBeNull();
  });

  it.each([
    { type: 'recovery_action_selected' },
    { type: 'recovery_action_failed', message: 'blocked' },
    { type: 'recovery_resolved', outcome: 'continued' },
  ] as const)(
    '$type names the halted seat, and a log written before the seat still parses',
    (variant) => {
      const base = {
        ts: 1,
        phase: 'planning',
        issueId: 'issue-1',
        reason: 'runner-usage-limit',
        action: 'switch-seat',
        ...variant,
      } as const;

      const old = parseEngineEvent(base);
      expect(old).toEqual(expect.objectContaining({ type: variant.type }));
      expect(old).not.toHaveProperty('seat');
      expect(parseEngineEvent({ ...base, seat: 'plan' })).toEqual(
        expect.objectContaining({ type: variant.type, seat: 'plan' }),
      );
      expect(parseEngineEvent({ ...base, seat: 'desk' })).toBeNull();
    },
  );

  it('round-trips a seat switch naming the seat it left and the seat it moved to', () => {
    const parsed = parseEngineEvent({
      type: 'seat_switched',
      ts: 1,
      phase: 'implementing',
      seat: 'build',
      from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
      to: { tool: 'claude-code', model: 'claude-sonnet-4' },
      cause: 'runner-usage-limit',
      auto: true,
      configRevision: 'abc123',
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        type: 'seat_switched',
        seat: 'build',
        from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        to: { tool: 'claude-code', model: 'claude-sonnet-4' },
        cause: 'runner-usage-limit',
        auto: true,
        configRevision: 'abc123',
      }),
    );
  });

  it('rejects a seat switch that names no seat to move to', () => {
    expect(
      parseEngineEvent({
        type: 'seat_switched',
        ts: 1,
        phase: 'implementing',
        seat: 'build',
        from: { tool: 'opencode' },
        cause: 'runner-usage-limit',
        auto: true,
        configRevision: 'abc123',
      }),
    ).toBeNull();
  });
});
