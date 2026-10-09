import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '../events/schema.js';
import { projectRunnerCallEvent, projectRunnerCallEvents } from './event-projection.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import type { RunnerCallEvent } from './types.js';
import { normalizeRunnerCallWarning } from './warnings.js';

describe('projectRunnerCallEvent', () => {
  it('keeps a native session event without adding session activity', () => {
    const events = projectRunnerCallEvents(
      {
        type: 'call_session_id',
        ts: 0,
        callId: 'session-call',
        role: 'implementer',
        backendKind: 'cli',
        nativeSessionId: 'native-1',
      },
      { rootDir: '/workspace', phase: 'implementing', sequence: 1 },
    );
    expect(events.map((event) => event.type)).toEqual(['runner_call_session_id']);
    expect(events[0]).toMatchObject({ nativeSessionId: 'native-1' });
  });

  it('projects call events to strict engine event variants', () => {
    const event: RunnerCallEvent = {
      type: 'call_usage',
      ts: 10,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      usage: { inputTokens: 5, outputTokens: 6 },
      semantics: 'delta',
    };

    expect(
      projectRunnerCallEvent(event, { rootDir: '/project', phase: 'planning', sequence: 3 }),
    ).toEqual({
      type: 'runner_call_usage',
      ts: 10,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      sequence: 3,
      usage: { inputTokens: 5, outputTokens: 6 },
      semantics: 'delta',
    });
  });

  it('preserves text delta channels when projecting runner call events', () => {
    const event: RunnerCallEvent = {
      type: 'call_text_delta',
      ts: 11,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      channel: 'assistant',
      text: 'assistant answer',
    };

    expect(
      projectRunnerCallEvent(event, { rootDir: '/project', phase: 'planning', sequence: 4 }),
    ).toEqual({
      type: 'runner_call_text_delta',
      ts: 11,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 4,
      channel: 'assistant',
      text: 'assistant answer',
      semantics: 'delta',
    });
  });

  it('preserves final text semantics when projecting runner call events', () => {
    const event: RunnerCallEvent = {
      type: 'call_text_delta',
      ts: 11,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      channel: 'result',
      text: 'final answer',
      semantics: 'final',
    };

    expect(
      projectRunnerCallEvent(event, { rootDir: '/project', phase: 'planning', sequence: 4 }),
    ).toEqual({
      type: 'runner_call_text_delta',
      ts: 11,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 4,
      channel: 'result',
      text: 'final answer',
      semantics: 'final',
    });
  });

  it('projects tool-use delta and done events with lifecycle stage', () => {
    expect(
      projectRunnerCallEvent(
        {
          type: 'call_tool_use_delta',
          ts: 12,
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          channel: 'tool',
          toolUseId: null,
          name: 'Bash',
          inputDelta: '{"command":"npm',
        },
        { rootDir: '/project', phase: 'planning', sequence: 5 },
      ),
    ).toEqual({
      type: 'runner_call_tool_use',
      ts: 12,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 5,
      stage: 'delta',
      toolUseId: null,
      name: 'Bash',
      inputDelta: '{"command":"npm',
    });

    expect(
      projectRunnerCallEvent(
        {
          type: 'call_tool_use_done',
          ts: 13,
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          channel: 'tool',
          toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
        },
        { rootDir: '/project', phase: 'planning', sequence: 6 },
      ),
    ).toEqual({
      type: 'runner_call_tool_use',
      ts: 13,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 6,
      stage: 'done',
      toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
    });
  });

  it('adds safe activity projections next to raw runner call payload events', () => {
    const projected = projectRunnerCallEvents(
      {
        type: 'call_tool_use_done',
        ts: 13,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        channel: 'tool',
        toolUse: {
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'echo sk-abcdefghijklmnopqrst' },
        },
      },
      { rootDir: '/project', phase: 'planning', sequence: 6 },
    );

    expect(projected).toEqual([
      expect.objectContaining({
        type: 'runner_call_tool_use',
        sequence: 6,
        toolUse: expect.objectContaining({
          input: { command: 'echo sk-abcdefghijklmnopqrst' },
        }),
      }),
      expect.objectContaining({
        type: 'runner_call_activity',
        sequence: 6,
        activityId: 'call-1:tool:tool-1',
        stage: 'completed',
        kind: 'command',
        label: 'running echo sk-***REDACTED***',
        redacted: true,
      }),
    ]);
  });

  it('projects terminal events with frozen timing and metadata', () => {
    const event: RunnerCallEvent = {
      type: 'call_completed',
      ts: 20,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      runnerName: 'custom-endpoint',
      model: 'gpt-5',
      attempt: 1,
      status: 'completed',
      error: null,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      partial: false,
      usage: { inputTokens: 5, outputTokens: 6 },
      nativeSessionId: null,
    };

    expect(
      projectRunnerCallEvent(event, { rootDir: '/project', phase: 'planning', sequence: 4 }),
    ).toEqual({
      type: 'runner_call_completed',
      ts: 20,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      runnerName: 'custom-endpoint',
      model: 'gpt-5',
      attempt: 1,
      sequence: 4,
      status: 'completed',
      error: null,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      partial: false,
      usage: { inputTokens: 5, outputTokens: 6 },
      nativeSessionId: null,
    });
  });

  it('adds no activity row for a completed call', () => {
    const projected = projectRunnerCallEvents(
      {
        type: 'call_completed',
        ts: 20,
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        status: 'completed',
        error: null,
        startedAt: 10,
        endedAt: 20,
        durationMs: 10,
        partial: false,
        usage: null,
        nativeSessionId: null,
      },
      { rootDir: '/project', phase: 'implementing', sequence: 7 },
    );

    expect(projected).toEqual([
      expect.objectContaining({ type: 'runner_call_completed', sequence: 7 }),
    ]);
  });

  it('keeps stderr deltas out of primary warning projection by default', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_stderr_delta',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'api',
        channel: 'stderr',
        text: 'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH + 100),
      },
      { rootDir: '/project', phase: 'planning', sequence: 5 },
    );

    expect(projected).toBeNull();
    expect(
      projectRunnerCallEvents(
        {
          type: 'call_stderr_delta',
          ts: 10,
          callId: 'call-1',
          role: 'planner',
          backendKind: 'api',
          channel: 'stderr',
          text: 'benign progress',
        },
        { rootDir: '/project', phase: 'planning', sequence: 5 },
      ),
    ).toEqual([]);
  });

  it('projects explicit runner call warnings with severity and fingerprint', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_warning',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'api',
        warning: normalizeRunnerCallWarning({
          code: 'provider_retry',
          severity: 'warning',
          source: 'provider',
          message: 'retrying request at 2026-06-21T10:00:00.000Z after 23ms',
        }),
      },
      { rootDir: '/project', phase: 'planning', sequence: 5 },
    );

    expect(EngineEventSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      type: 'runner_call_warning',
      warning: {
        code: 'provider_retry',
        severity: 'warning',
        source: 'provider',
        surface: 'activity',
        message: 'retrying request at 2026-06-21T10:00:00.000Z after 23ms',
        fingerprint: expect.stringMatching(/^rw:/),
      },
    });
  });

  it('projects unknown-upstream diagnostics as redacted warnings with parser metadata', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_unknown_upstream',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        rawPreview: 'payload sk-abcdefghijklmnopqrstuvwxyz',
        backendMetadata: {
          backendKind: 'cli',
          source: 'jsonl',
          parser: 'jsonl',
          channel: 'stdout',
          upstreamType: 'future',
        },
      },
      { rootDir: '/project', phase: 'planning', sequence: 5 },
    );

    expect(projected).toMatchObject({
      type: 'runner_call_warning',
      warning: {
        code: 'unknown_upstream',
        source: 'jsonl',
        parser: 'jsonl',
        channel: 'stdout',
        upstreamType: 'future',
        message: expect.stringContaining('sk-***REDACTED***'),
      },
    });
    expect(JSON.stringify(projected)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('bounds projected runner call error messages to the engine event schema limit', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_error',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'api',
        status: 'failed',
        error: { code: 'failed', message: 'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH + 100) },
        startedAt: 1,
        endedAt: 10,
        durationMs: 9,
        partial: true,
        usage: null,
        nativeSessionId: null,
      },
      { rootDir: '/project', phase: 'planning', sequence: 5 },
    );

    expect(EngineEventSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      type: 'runner_call_error',
      error: {
        code: 'failed',
        message: `${'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`,
      },
    });
  });
});
