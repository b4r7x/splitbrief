import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEngineEvent, appendMessage, createSessionLogAppender } from './log-writer.js';
import { SessionLogEventEntrySchema } from '../schemas/session-log.js';
import { taskId } from '../schemas/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';
const itUnix = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('session-log-writer');
  return tmp;
}

describe('appendEngineEvent', () => {
  it('appends JSONL lines to session log file with kind:event and ISO ts', () => {
    const dir = makeTmp();
    const event1 = {
      ts: 1000,
      type: 'task_started',
      taskId: taskId('T001'),
      phase: 'implementing' as const,
      title: 'Task 1',
      index: 0,
      total: 1,
      file: 'src/x.ts',
      action: 'create',
    };
    const event2 = {
      ts: 2000,
      type: 'task_completed',
      taskId: taskId('T001'),
      phase: 'implementing' as const,
      title: 'Task 1',
      method: 'local',
      retries: 0,
      duration: 100,
    };

    appendEngineEvent({ projectDir: dir, sessionId: SESSION_ID }, event1);
    appendEngineEvent({ projectDir: dir, sessionId: SESSION_ID }, event2);

    const raw = readFileSync(
      join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const entry1 = JSON.parse(lines[0] ?? '');
    const entry2 = JSON.parse(lines[1] ?? '');
    expect(entry1.kind).toBe('event');
    expect(entry1.ts).toBe(new Date(1000).toISOString());
    expect(entry1.type).toBe('task_started');
    expect(entry2.kind).toBe('event');
    expect(entry2.ts).toBe(new Date(2000).toISOString());
    expect(entry2.type).toBe('task_completed');
  });

  it('creates directory when it does not exist', () => {
    const dir = makeTmp();
    const event = {
      ts: 1000,
      type: 'workflow_started',
      phase: 'idle' as const,
      feature: 'test-feature',
    };
    appendEngineEvent({ projectDir: dir, sessionId: SESSION_ID }, event);
    expect(existsSync(join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'))).toBe(
      true,
    );
  });

  itUnix('creates session logs with 0600 permissions', () => {
    const dir = makeTmp();
    appendEngineEvent(
      { projectDir: dir, sessionId: SESSION_ID },
      {
        ts: 1000,
        type: 'workflow_started',
        phase: 'idle',
        feature: 'test-feature',
      },
    );

    const mode =
      statSync(join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('persists phase-less events in a schema-valid log entry', () => {
    const dir = makeTmp();
    appendEngineEvent(
      { projectDir: dir, sessionId: SESSION_ID },
      {
        ts: 1000,
        type: 'approval_mode_changed',
        mode: 'yolo',
      },
    );

    const raw = readFileSync(
      join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(raw.trim());

    expect(entry.phase).toBeUndefined();
    expect(entry.data).toEqual({ mode: 'yolo' });
    expect(SessionLogEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('warns to stderr and does not throw when write fails on a read-only session dir', () => {
    const dir = makeTmp();
    const sessionPath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(sessionPath, { recursive: true });
    chmodSync(sessionPath, 0o500);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const event = {
        ts: 1000,
        type: 'workflow_started',
        phase: 'idle' as const,
        feature: 'test-feature',
      };
      expect(() =>
        appendEngineEvent({ projectDir: dir, sessionId: SESSION_ID }, event),
      ).not.toThrow();
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('failed to persist log entry');
    } finally {
      stderrSpy.mockRestore();
      chmodSync(sessionPath, 0o700);
    }
  });
});

describe('createSessionLogAppender', () => {
  it('appends each entry as a single JSONL line on disk from one resolved appender', () => {
    const dir = makeTmp();
    const append = createSessionLogAppender({ projectDir: dir, sessionId: SESSION_ID });

    append({ kind: 'event', ts: '1', type: 'workflow_started', data: { feature: 'a' } });
    append({ kind: 'event', ts: '2', type: 'instant_plan_received', data: { taskCount: 3 } });
    append({ kind: 'message', ts: '3', role: 'user', text: 'hi' });

    const raw = readFileSync(
      join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '').type).toBe('workflow_started');
    expect(JSON.parse(lines[1] ?? '').type).toBe('instant_plan_received');
    expect(JSON.parse(lines[2] ?? '').role).toBe('user');
  });

  it('reuses a single appender across many appends without losing earlier lines', () => {
    const dir = makeTmp();
    const append = createSessionLogAppender({ projectDir: dir, sessionId: SESSION_ID });
    for (let i = 0; i < 50; i++) {
      append({ kind: 'event', ts: String(i), type: 'planner_text', data: { text: `chunk ${i}` } });
    }
    const raw = readFileSync(
      join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    expect(raw.split('\n').filter(Boolean)).toHaveLength(50);
  });

  itUnix('refuses to append through a symlinked session log', () => {
    const outside = mkdtempSync(join(tmpdir(), 'splitbrief-log-outside-'));
    const dir = makeTmp();
    const sessionPath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(sessionPath, { recursive: true });
    const outsideLog = join(outside, 'session.jsonl');
    writeFileSync(outsideLog, '');
    symlinkSync(outsideLog, join(sessionPath, 'session.jsonl'));

    const append = createSessionLogAppender({ projectDir: dir, sessionId: SESSION_ID });
    expect(() => append({ kind: 'event', ts: '1', type: 'workflow_started', data: {} })).toThrow(
      /refusing to write through symlink/,
    );
    expect(readFileSync(outsideLog, 'utf-8')).toBe('');

    rmSync(outside, { recursive: true, force: true });
  });
});

describe('appendMessage', () => {
  it('writes kind:message entry with ISO ts', () => {
    const dir = makeTmp();
    appendMessage({ projectDir: dir, sessionId: SESSION_ID }, { role: 'user', text: 'add auth' });
    const raw = readFileSync(
      join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(raw.trim());
    expect(entry.kind).toBe('message');
    expect(entry.role).toBe('user');
    expect(entry.text).toBe('add auth');
    expect(typeof entry.ts).toBe('string');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes optional fields when provided', () => {
    const dir = makeTmp();
    appendMessage(
      { projectDir: dir, sessionId: SESSION_ID },
      { role: 'assistant', phase: 'researching', text: 'hello', interrupted: true },
    );
    const raw = readFileSync(
      join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(raw.trim());
    expect(entry.phase).toBe('researching');
    expect(entry.interrupted).toBe(true);
  });
});

describe('session append symlink confinement', () => {
  itUnix('appendEngineEvent refuses to append through a symlinked session log', () => {
    const outside = mkdtempSync(join(tmpdir(), 'splitbrief-log-outside-'));
    const dir = makeTmp();
    const sessionPath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(sessionPath, { recursive: true });
    const outsideLog = join(outside, 'session.jsonl');
    writeFileSync(outsideLog, '');
    symlinkSync(outsideLog, join(sessionPath, 'session.jsonl'));

    expect(() =>
      appendEngineEvent(
        { projectDir: dir, sessionId: SESSION_ID },
        { ts: 1000, type: 'workflow_started', phase: 'planning' },
      ),
    ).toThrow(/refusing to write through symlink/);
    expect(readFileSync(outsideLog, 'utf-8')).toBe('');

    rmSync(outside, { recursive: true, force: true });
  });

  itUnix('appendMessage refuses to append through a symlinked session log', () => {
    const outside = mkdtempSync(join(tmpdir(), 'splitbrief-log-outside-'));
    const dir = makeTmp();
    const sessionPath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(sessionPath, { recursive: true });
    const outsideLog = join(outside, 'session.jsonl');
    writeFileSync(outsideLog, '');
    symlinkSync(outsideLog, join(sessionPath, 'session.jsonl'));

    expect(() =>
      appendMessage({ projectDir: dir, sessionId: SESSION_ID }, { role: 'user', text: 'hi' }),
    ).toThrow(/refusing to write through symlink/);
    expect(readFileSync(outsideLog, 'utf-8')).toBe('');

    rmSync(outside, { recursive: true, force: true });
  });
});
