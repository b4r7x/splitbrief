import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { saveState, loadState, appendEngineEvent, appendMessage } from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../schemas/task.js';
import type { RecoveryIssue } from '../schemas/recovery.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';

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
    saveState(dir, SESSION_ID, state);
    const loaded = loadState(dir, SESSION_ID);
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
    saveState(dir, SESSION_ID, state);
    const loaded = loadState(dir, SESSION_ID);
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
    saveState(nested, SESSION_ID, createInitialState('feat'));
    expect(existsSync(join(nested, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'state.json'))).toBe(true);
  });

  it('preserves pending recovery in roundtrip', () => {
    const dir = makeTmp();
    const issue: RecoveryIssue = {
      id: 'rec_2026_04_28_004',
      reason: 'context-overflow',
      phase: 'implementing',
      status: 'awaiting-user',
      taskId: taskId('T002'),
      taskTitle: 'Split large task',
      files: ['src/large.ts'],
      affectedTaskIds: [taskId('T002')],
      message: 'Task prompt exceeds the selected worker context window',
      details: ['Estimated 42,000 tokens for a 32,768 token worker'],
      selectedImplementerProfile: 'local-qwen',
      facts: {
        estimatedTokens: 42_000,
        contextLimit: 32_768,
      },
      availableActions: ['route-bigger-worker', 'planner-split-rebase', 'pause-run', 'abort-workflow'],
      recommendedAction: 'route-bigger-worker',
      createdAt: '2026-04-28T12:00:00.000Z',
    };
    const state = {
      ...createInitialState('recoverable-feature'),
      phase: 'implementing' as const,
      pendingRecovery: issue,
    };

    saveState(dir, SESSION_ID, state);
    const loaded = loadState(dir, SESSION_ID);

    expect(loaded?.pendingRecovery).toEqual(issue);
    expect(loaded?.phase).toBe('implementing');
  });
});

describe('loadState', () => {
  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });

  it('returns null when state is malformed (missing phase)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, tasks: [] }));
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });

  it('returns null when state is malformed (tasks not an array)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ stateVersion: 2, phase: 'idle', tasks: 'not-array' }));
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });

  it('returns null when state file contains invalid JSON', () => {
    const dir = makeTmp();
    const stateDir = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), '{not valid json!!!');
    expect(loadState(dir, SESSION_ID)).toBeNull();
  });
});

describe('appendEngineEvent', () => {
  it('appends JSONL lines to session log file with kind:event and ISO ts', () => {
    const dir = makeTmp();
    const event1: EngineEvent = { ts: 1000, type: 'task_started', taskId: taskId('T001'), phase: 'implementing', title: 'Task 1', index: 0, total: 1, file: 'src/x.ts', action: 'create' };
    const event2: EngineEvent = { ts: 2000, type: 'task_completed', taskId: taskId('T001'), phase: 'implementing', title: 'Task 1', method: 'local', retries: 0, duration: 100 };

    appendEngineEvent(dir, SESSION_ID, event1);
    appendEngineEvent(dir, SESSION_ID, event2);

    const raw = readFileSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'), 'utf-8');
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
    const event: EngineEvent = { ts: 1000, type: 'workflow_started', phase: 'idle', feature: 'test-feature' };
    appendEngineEvent(dir, SESSION_ID, event);
    expect(existsSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'))).toBe(true);
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
      const event: EngineEvent = { ts: 1000, type: 'workflow_started', phase: 'idle', feature: 'test-feature' };
      expect(() => appendEngineEvent(dir, SESSION_ID, event)).not.toThrow();
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
    appendMessage(dir, SESSION_ID, { role: 'user', text: 'add auth' }, true);
    const raw = readFileSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.kind).toBe('message');
    expect(entry.role).toBe('user');
    expect(entry.text).toBe('add auth');
    expect(typeof entry.ts).toBe('string');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not write anything when persistTranscript is false', () => {
    const dir = makeTmp();
    appendMessage(dir, SESSION_ID, { role: 'assistant', text: 'planner output' }, false);
    const filePath = join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl');
    expect(existsSync(filePath)).toBe(false);
  });

  it('includes optional fields when provided', () => {
    const dir = makeTmp();
    appendMessage(dir, SESSION_ID, { role: 'assistant', phase: 'researching', text: 'hello', interrupted: true }, true);
    const raw = readFileSync(join(dir, DIPTYCH_DIR, SESSIONS_DIR, SESSION_ID, 'session.jsonl'), 'utf-8');
    const entry = JSON.parse(raw.trim());
    expect(entry.phase).toBe('researching');
    expect(entry.interrupted).toBe(true);
  });
});
