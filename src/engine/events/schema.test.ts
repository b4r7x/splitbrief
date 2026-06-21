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
  it('accepts known events with required variant fields', () => {
    expect(
      parseEngineEvent({
        type: 'task_completed',
        ts: 1,
        phase: 'implementing',
        taskId: 'T001',
        title: 'Finish task',
        method: 'local',
        retries: 0,
        duration: 10,
      }),
    ).toEqual(expect.objectContaining({ type: 'task_completed' }));
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
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'assistant',
      }),
    );
  });

  it('normalizes legacy runner text deltas without a channel as stdout', () => {
    expect(
      parseEngineEvent({
        type: 'runner_call_text_delta',
        ts: 1,
        phase: 'planning',
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        text: 'legacy output',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_text_delta',
        channel: 'stdout',
      }),
    );
  });

  it('normalizes legacy runner tool-use events without a lifecycle stage', () => {
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
    ).toEqual(
      expect.objectContaining({
        type: 'runner_call_tool_use',
        stage: 'done',
      }),
    );
    expect(
      parseEngineEvent({
        ...base,
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
        accumulatedTokens: 900,
        callId: 'planner-call-1',
        phaseHint: 'reading files',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'planner_heartbeat',
        callId: 'planner-call-1',
      }),
    );
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
});
