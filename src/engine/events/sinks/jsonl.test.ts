import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonlSink } from './jsonl.js';
import { ensureDiptychDir, ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { taskId } from '../../../core/schemas/task.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../../core/schemas/session-log.js';

describe('jsonlSink', () => {
  let projectDir: string;
  const sessionId = 'test-session';

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'diptych-jsonl-'));
    ensureDiptychDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readLog(): Array<Record<string, unknown>> {
    const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('writes event-kind entries with on-disk shape (kind, ts ISO, type, phase, data)', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
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

  it('drops planner_text events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({ type: 'planner_text', ts: 100, phase: 'researching', text: 'thinking...' });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('drops user_message events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({ type: 'user_message', ts: 100, phase: 'researching', text: 'hi' });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('drops clarification_answered events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({ type: 'clarification_answered', ts: 100, phase: 'clarifying', answer: 'yes' });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('drops implementer_generate_done events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'implementer_generate_done',
      ts: 100,
      phase: 'implementing',
      taskId: taskId('T001'),
      file: 'a.ts',
      linesAdded: 10,
      linesRemoved: 5,
      duration: 100,
      diff: 'big diff here',
    });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('serializes taskId outside data when present', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
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

  it('does not persist oversized session-log entries', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
      sink({
        type: 'warning',
        ts: 100,
        phase: 'idle',
        message: 'x'.repeat(SESSION_LOG_MAX_ENTRY_BYTES + 1),
      });

      const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
      expect(existsSync(path) ? readLog() : []).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('failed to persist oversized log entry'),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
