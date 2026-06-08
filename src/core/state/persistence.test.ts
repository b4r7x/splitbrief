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
import { saveState, loadState, appendEngineEvent, appendMessage } from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../schemas/task.js';
import { SessionLogEventEntrySchema } from '../schemas/session-log.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';
const itUnix = process.platform === 'win32' ? it.skip : it;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('state-persist');
  return tmp;
}

describe('saveState / loadState roundtrip', () => {
  it('writes JSON and reads it back identically', () => {
    const dir = makeTmp();
    const state = createInitialState('my-feature');
    saveState({ projectDir: dir, sessionId: SESSION_ID }, state);
    const loaded = loadState({ projectDir: dir, sessionId: SESSION_ID });
    expect(loaded).toEqual(state);
  });

  it('preserves tool/model fields in roundtrip', () => {
    const dir = makeTmp();
    const state = {
      ...createInitialState('model-test'),
      plannerTool: 'openrouter',
      plannerModel: 'claude-sonnet-4-20250514',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:14b',
    };
    saveState({ projectDir: dir, sessionId: SESSION_ID }, state);
    const loaded = loadState({ projectDir: dir, sessionId: SESSION_ID });
    if (!loaded) throw new Error('expected loadState to return saved state');
    expect(loaded.plannerTool).toBe('openrouter');
    expect(loaded.plannerModel).toBe('claude-sonnet-4-20250514');
    expect(loaded.implementerTool).toBe('ollama');
    expect(loaded.implementerModel).toBe('qwen2.5-coder:14b');
  });

  it('creates session directory when it does not exist', () => {
    const dir = makeTmp();
    const nested = join(dir, 'deep', 'nested');
    expect(existsSync(nested)).toBe(false);
    saveState({ projectDir: nested, sessionId: SESSION_ID }, createInitialState('feat'));
    expect(existsSync(join(nested, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'state.json'))).toBe(
      true,
    );
  });

  it('preserves external metadata in roundtrip', () => {
    const dir = makeTmp();
    const state = {
      ...createInitialState('external-meta'),
      external: { 'my-board': { lanes: { T001: 'in-review' } } },
    };
    saveState({ projectDir: dir, sessionId: SESSION_ID }, state);
    const loaded = loadState({ projectDir: dir, sessionId: SESSION_ID });
    expect(loaded?.external).toEqual({ 'my-board': { lanes: { T001: 'in-review' } } });
  });

  it('preserves pending recovery in roundtrip', () => {
    const dir = makeTmp();
    const issue = makeRecoveryIssue({
      id: 'rec_2026_04_28_004',
      reason: 'context-overflow',
      phase: 'implementing',
      taskId: taskId('T002'),
      taskTitle: 'Split large task',
      files: ['src/large.ts'],
      affectedTaskIds: [taskId('T002')],
      message: 'Task prompt exceeds the selected worker context window',
      details: ['Estimated 42,000 tokens for a 32,768 token worker'],
      facts: {
        estimatedTokens: 42_000,
        contextLimit: 32_768,
      },
      availableActions: ['route-bigger-worker', 'retry-same-worker', 'pause-run', 'abort-workflow'],
      recommendedAction: 'route-bigger-worker',
    });
    const state = {
      ...createInitialState('recoverable-feature'),
      phase: 'implementing' as const,
      pendingRecovery: issue,
    };

    saveState({ projectDir: dir, sessionId: SESSION_ID }, state);
    const loaded = loadState({ projectDir: dir, sessionId: SESSION_ID });

    expect(loaded?.pendingRecovery).toEqual(issue);
    expect(loaded?.phase).toBe('implementing');
  });

  it('rejects unsafe session ids before writing state', () => {
    const dir = makeTmp();

    expect(() =>
      saveState({ projectDir: dir, sessionId: '../outside' }, createInitialState('feat')),
    ).toThrow(/Invalid session id/);
    expect(existsSync(join(dir, 'outside', 'state.json'))).toBe(false);
  });
});

describe('loadState', () => {
  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
  });

  it('returns null when state is malformed (missing phase)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, tasks: [] }));
    expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
  });

  it('returns null when state is malformed (tasks not an array)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'state.json'),
      JSON.stringify({ stateVersion: 2, phase: 'idle', tasks: 'not-array' }),
    );
    expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
  });

  it('returns null when state file contains invalid JSON', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), '{not valid json!!!');
    expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
  });
});

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
      join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
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
    expect(existsSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'))).toBe(
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
      statSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl')).mode & 0o777;
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
      join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(raw.trim());

    expect(entry.phase).toBeUndefined();
    expect(entry.data).toEqual({ mode: 'yolo' });
    expect(SessionLogEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('warns to stderr and does not throw when write fails on a read-only session dir', () => {
    // Real disk-permission failure — no vi.mock. The session dir exists but is
    // read-only (mode 0o500), so appendFileSync genuinely fails with EACCES.
    const dir = makeTmp();
    const sessionPath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(sessionPath, { recursive: true });
    // Remove write permission from the session dir. On POSIX this makes
    // appendFileSync fail for files that don't yet exist inside it.
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
      // Restore perms so cleanupTempDir can remove the directory.
      chmodSync(sessionPath, 0o700);
    }
  });
});

describe('appendMessage', () => {
  it('writes kind:message entry with ISO ts when persistTranscript is true', () => {
    const dir = makeTmp();
    appendMessage(
      { projectDir: dir, sessionId: SESSION_ID },
      { role: 'user', text: 'add auth' },
      true,
    );
    const raw = readFileSync(
      join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(raw.trim());
    expect(entry.kind).toBe('message');
    expect(entry.role).toBe('user');
    expect(entry.text).toBe('add auth');
    expect(typeof entry.ts).toBe('string');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not write anything when persistTranscript is false', () => {
    const dir = makeTmp();
    appendMessage(
      { projectDir: dir, sessionId: SESSION_ID },
      { role: 'assistant', text: 'planner output' },
      false,
    );
    const filePath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl');
    expect(existsSync(filePath)).toBe(false);
  });

  it('includes optional fields when provided', () => {
    const dir = makeTmp();
    appendMessage(
      { projectDir: dir, sessionId: SESSION_ID },
      { role: 'assistant', phase: 'researching', text: 'hello', interrupted: true },
      true,
    );
    const raw = readFileSync(
      join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'),
      'utf-8',
    );
    const entry = JSON.parse(raw.trim());
    expect(entry.phase).toBe('researching');
    expect(entry.interrupted).toBe(true);
  });
});

describe('session append symlink confinement', () => {
  itUnix('appendEngineEvent refuses to append through a symlinked session log', () => {
    const outside = mkdtempSync(join(tmpdir(), 'diptych-log-outside-'));
    const dir = makeTmp();
    const sessionPath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
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
    const outside = mkdtempSync(join(tmpdir(), 'diptych-log-outside-'));
    const dir = makeTmp();
    const sessionPath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(sessionPath, { recursive: true });
    const outsideLog = join(outside, 'session.jsonl');
    writeFileSync(outsideLog, '');
    symlinkSync(outsideLog, join(sessionPath, 'session.jsonl'));

    expect(() =>
      appendMessage({ projectDir: dir, sessionId: SESSION_ID }, { role: 'user', text: 'hi' }, true),
    ).toThrow(/refusing to write through symlink/);
    expect(readFileSync(outsideLog, 'utf-8')).toBe('');

    rmSync(outside, { recursive: true, force: true });
  });
});
