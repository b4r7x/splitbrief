import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonlSink } from './jsonl.js';
import { createEventBus } from '../bus.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { taskId } from '../../../core/schemas/task.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../../core/schemas/session-log.js';
import { CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER } from '../../../core/payload-bounds.js';
import type { EngineEvent } from '../types.js';

describe('jsonlSink', () => {
  let projectDir: string;
  const sessionId = 'test-session';

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-jsonl-'));
    ensureSplitbriefDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readLog(): Array<Record<string, unknown>> {
    const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('writes event-kind entries with on-disk shape (kind, ts ISO, type, phase, data)', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    sink({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'add x' });
    sink({ type: 'instant_plan_received', ts: 200, phase: 'planning', taskCount: 3 });

    const lines = readLog();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: 'event',
      type: 'workflow_started',
      phase: 'idle',
      data: { feature: 'add x' },
    });
    expect(typeof lines[0]?.['ts']).toBe('string');
    expect(String(lines[0]?.['ts'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[1]).toMatchObject({
      kind: 'event',
      type: 'instant_plan_received',
      phase: 'planning',
      data: { taskCount: 3 },
    });
  });

  it('serializes taskId outside data when present', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    sink({
      type: 'task_started',
      ts: 100,
      phase: 'implementing',
      taskId: taskId('T099'),
      title: 't',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    const lines = readLog();
    expect(lines[0]?.['taskId']).toBe('T099');
    expect((lines[0]?.['data'] as Record<string, unknown>)?.['taskId']).toBeUndefined();
  });

  it('bounds oversized session-log strings before persisting', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sink = createJsonlSink({ projectDir, sessionId });
      sink({
        type: 'warning',
        ts: 100,
        phase: 'idle',
        message: 'x'.repeat(SESSION_LOG_MAX_ENTRY_BYTES + 1),
      });

      const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
      expect(existsSync(path)).toBe(true);
      const lines = readLog();
      expect((lines[0]?.['data'] as Record<string, unknown>)?.['message']).toContain(
        CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER,
      );
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('failed to persist oversized log entry'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('publishes one degraded warning when session.jsonl appends fail and keeps the bus running', () => {
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    symlinkSync(join(projectDir, 'outside-session.jsonl'), logPath);
    const bus = createEventBus();
    const events: EngineEvent[] = [];
    bus.subscribe((event) => events.push(event));
    bus.subscribe(
      createJsonlSink({
        projectDir,
        sessionId,
        onDegraded: (warning) => bus.publish(warning),
      }),
    );

    expect(() => {
      bus.publish({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'x' });
      bus.publish({ type: 'workflow_complete', ts: 200, phase: 'idle' });
    }).not.toThrow();

    const degradedWarnings = events.filter(
      (event) => event.type === 'warning' && event.code === 'session_log_degraded',
    );
    expect(degradedWarnings).toHaveLength(1);
    expect(degradedWarnings[0]).toMatchObject({
      type: 'warning',
      category: 'jsonl',
      code: 'session_log_degraded',
    });
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(true);
  });

  it('does not write runner_call_text_delta to session.jsonl', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');

    sink({
      type: 'runner_call_text_delta',
      ts: 100,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      channel: 'assistant',
      text: 'delta text',
    });
    expect(existsSync(logPath)).toBe(false);

    sink({ type: 'workflow_started', ts: 101, phase: 'idle', feature: 'x' });
    expect(existsSync(logPath)).toBe(true);
    expect(readLog()).toHaveLength(1);

    sink({
      type: 'runner_call_text_delta',
      ts: 102,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      channel: 'assistant',
      text: 'more delta',
    });
    expect(readLog()).toHaveLength(1);
  });

  it('does not write runner_call_tool_use with stage delta but writes stage done', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');

    sink({
      type: 'runner_call_tool_use',
      ts: 100,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      stage: 'delta',
      toolUseId: 'tool-1',
      name: 'Bash',
      inputDelta: '{"cmd":',
    });
    expect(existsSync(logPath)).toBe(false);

    sink({
      type: 'runner_call_tool_use',
      ts: 101,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      stage: 'done',
      toolUse: { id: 'tool-1', name: 'Bash', input: { cmd: 'ls' } },
    });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('runner_call_tool_use');
  });

  it('does not write planner_heartbeat to session.jsonl', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');

    sink({
      type: 'planner_heartbeat',
      ts: 100,
      phase: 'planning',
      elapsedMs: 5000,
    });
    expect(existsSync(logPath)).toBe(false);
  });

  it('does not write runner_call_heartbeat to session.jsonl', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    const logPath = join(sessionDir(projectDir, sessionId), 'session.jsonl');

    sink({
      type: 'runner_call_heartbeat',
      ts: 100,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
    });
    expect(existsSync(logPath)).toBe(false);
  });

  it('writes each retained event kind as exactly one line with matching type', () => {
    const sink = createJsonlSink({ projectDir, sessionId });
    const events: EngineEvent[] = [
      {
        type: 'runner_call_activity',
        ts: 100,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 1,
        activityId: 'act-1',
        stage: 'completed',
        kind: 'command',
        label: 'running tests',
        redacted: false,
      },
      {
        type: 'runner_call_started',
        ts: 101,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 0,
      },
      {
        type: 'runner_call_usage',
        ts: 102,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 2,
        usage: { inputTokens: 10, outputTokens: 5 },
        semantics: 'final',
      },
      {
        type: 'runner_call_completed',
        ts: 103,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 3,
        status: 'completed',
        error: null,
        partial: false,
        startedAt: 100,
        endedAt: 103,
        durationMs: 3,
        usage: null,
        nativeSessionId: null,
      },
      {
        type: 'runner_call_error',
        ts: 104,
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 4,
        status: 'failed',
        error: { code: 'exit_1', message: 'failed' },
        partial: false,
        startedAt: 100,
        endedAt: 104,
        durationMs: 4,
        usage: null,
        nativeSessionId: null,
      },
      {
        type: 'planner_text',
        ts: 105,
        phase: 'planning',
        text: 'plan text',
      },
    ];

    for (const event of events) {
      sink(event);
    }

    const lines = readLog();
    expect(lines).toHaveLength(events.length);
    expect(lines.map((l) => l['type'])).toEqual([
      'runner_call_activity',
      'runner_call_started',
      'runner_call_usage',
      'runner_call_completed',
      'runner_call_error',
      'planner_text',
    ]);
  });

  it('bounds oversized planner_text strings before persisting', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sink = createJsonlSink({ projectDir, sessionId });
      sink({
        type: 'planner_text',
        ts: 100,
        phase: 'planning',
        text: 'x'.repeat(SESSION_LOG_MAX_ENTRY_BYTES + 1),
      });

      const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
      expect(existsSync(path)).toBe(true);
      const lines = readLog();
      expect(lines).toHaveLength(1);
      expect(lines[0]?.['type']).toBe('planner_text');
      expect((lines[0]?.['data'] as Record<string, unknown>)?.['text']).toContain(
        CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER,
      );
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('failed to persist oversized log entry'),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
