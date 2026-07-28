import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveState, loadState } from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../schemas/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';

const fsControl = vi.hoisted(() => ({ throwEnoentOnStatOnce: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (fsControl.throwEnoentOnStatOnce) {
        fsControl.throwEnoentOnStatOnce = false;
        const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return actual.statSync(...args);
    },
  };
});

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';

afterEach(() => {
  fsControl.throwEnoentOnStatOnce = false;
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

  it('preserves an active changed-files snapshot in roundtrip', () => {
    const dir = makeTmp();
    const activeTaskSnapshot = {
      head: 'abc123',
      files: ['src/a.ts'],
      dirtyFileContents: { 'src/a.ts': 'before\n' },
      gitlinks: ['vendor/module'],
      baselineFileHashes: { 'src/a.ts': 'hash' },
      ignoreProjectDir: '/tmp/staged-project',
    };
    const state = {
      ...createInitialState('snapshot-roundtrip'),
      changedFilesBaseline: {
        head: 'abc123',
        fingerprints: { 'src/a.ts': 'hash' },
        activeTaskSnapshot,
      },
    };

    saveState({ projectDir: dir, sessionId: SESSION_ID }, state);
    const loaded = loadState({ projectDir: dir, sessionId: SESSION_ID });

    expect(loaded?.changedFilesBaseline?.activeTaskSnapshot).toEqual(activeTaskSnapshot);
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

describe('loadState mtime cache', () => {
  it('re-reads from disk when the file changes out of band', () => {
    const dir = makeTmp();
    const original = createInitialState('cache-feature');
    saveState({ projectDir: dir, sessionId: SESSION_ID }, original);
    loadState({ projectDir: dir, sessionId: SESSION_ID });

    const updated = { ...original, feature: 'cache-feature-renamed' };
    const statePath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'state.json');
    writeFileSync(statePath, JSON.stringify(updated));

    const loaded = loadState({ projectDir: dir, sessionId: SESSION_ID });
    expect(loaded?.feature).toBe('cache-feature-renamed');
  });
});

describe('loadState', () => {
  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
  });

  it('returns null when state is malformed (missing phase)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    const malformed = { ...createInitialState('missing-phase') };
    Reflect.deleteProperty(malformed, 'phase');
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(malformed));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('failed schema validation');
      expect(output).not.toContain('is incompatible');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns null when state is malformed (tasks not an array)', () => {
    const dir = makeTmp();
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    const malformed = { ...createInitialState('invalid-tasks'), tasks: 'not-array' };
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(malformed));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('failed schema validation');
      expect(output).not.toContain('is incompatible');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns null when state file contains invalid JSON', () => {
    const dir = makeTmp();
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), '{not valid json!!!');
    expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
  });

  it('warns about the incompatible version when state is from an older version', () => {
    const dir = makeTmp();
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    const older = { ...createInitialState('legacy'), stateVersion: 2 };
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(older));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('version 2 is incompatible');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('warns that schema validation failed for a current-version but malformed state', () => {
    const dir = makeTmp();
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    const malformed = { ...createInitialState('broken'), phase: 'not-a-real-phase' };
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(malformed));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('failed schema validation');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns null without throwing when the file disappears after the existence check', () => {
    const dir = makeTmp();
    saveState({ projectDir: dir, sessionId: SESSION_ID }, createInitialState('vanishing'));

    // Simulate the TOCTOU window: the file passes existsSync, then statSync
    // raises ENOENT because the file was removed before loadState stats it.
    // loadState must swallow that into null rather than propagating the throw.
    fsControl.throwEnoentOnStatOnce = true;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadState({ projectDir: dir, sessionId: SESSION_ID })).toBeNull();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
