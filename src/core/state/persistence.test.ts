import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitStateAuthorityFence,
  loadStateForResume,
  saveState,
  loadState,
} from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../schemas/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeLegacyV3State } from '#testing/helpers/factories/workflow-state.js';
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

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fencedAuthority(ref: { sessionId: string }, stateBytes: string, revision = 1) {
  return {
    kind: 'fenced' as const,
    promotedFromVersion: null,
    receipt: {
      kind: 'usable' as const,
      sessionId: ref.sessionId,
      ownerId: 'owner-1',
      pid: process.pid,
      processStart: 'test-start',
      runId: 'run-1',
      acquisitionId: 'acquisition-1',
      fence: 1,
      stateRevision: revision,
      stateDigest: digest(stateBytes),
    },
  };
}

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

  it('rejects malformed saves before replacing the last valid snapshot', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: SESSION_ID };
    const valid = createInitialState('durable-snapshot');
    saveState(ref, valid);
    const statePath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'state.json');
    const before = readFileSync(statePath);

    const malformed = { ...valid };
    Reflect.deleteProperty(malformed, 'stateFence');
    saveState(ref, malformed);

    expect(readFileSync(statePath)).toEqual(before);
    expect(loadState(ref)).toEqual(valid);
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

  it.each([
    [
      'missing phase',
      () => {
        const malformed = { ...createInitialState('missing-phase') };
        Reflect.deleteProperty(malformed, 'phase');
        return malformed;
      },
    ],
    ['tasks not an array', () => ({ ...createInitialState('invalid-tasks'), tasks: 'not-array' })],
    ['unknown phase', () => ({ ...createInitialState('broken'), phase: 'not-a-real-phase' })],
  ])('returns null and warns that schema validation failed for %s', (_name, build) => {
    const dir = makeTmp();
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify(build()));

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

describe('authority-bearing resume persistence', () => {
  it('keeps loadState strict while the resume seam migrates v3', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: SESSION_ID };
    saveState(ref, makeLegacyV3State());
    const statePath = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'state.json');
    const stateBytes = readFileSync(statePath, 'utf8');

    expect(loadState(ref)).toBeNull();
    const result = loadStateForResume({ ref, authority: fencedAuthority(ref, stateBytes) });

    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded') return;
    expect(result.migrated).toBe(true);
    expect(result.state.stateVersion).toBe(4);
    expect(result.state.briefRecovery?.status).toBe('storage-blocked');
    expect(loadState(ref)?.briefRecovery?.status).toBe('storage-blocked');
  });

  it('maps a valid legacy Brief/report pair to Contract Ready or Blocked', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: SESSION_ID };
    const state = makeLegacyV3State('legacy-artifacts');
    saveState(ref, state);
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    const brief = '# Task Briefs\n';
    const report = JSON.stringify({ version: 1, passed: true, score: 1, issues: [] });
    writeFileSync(join(stateDir, 'tasks.md'), brief);
    writeFileSync(join(stateDir, 'brief-quality.json'), report);
    const statePath = join(stateDir, 'state.json');
    const stateBytes = readFileSync(statePath, 'utf8');

    const result = loadStateForResume({ ref, authority: fencedAuthority(ref, stateBytes) });

    expect(result.kind).toBe('loaded');
    if (result.kind !== 'loaded') return;
    expect(result.state.briefRecovery?.status).toBe('ready');
    const recovery = result.state.briefRecovery;
    if (
      recovery === undefined ||
      recovery === null ||
      recovery.status === 'storage-blocked' ||
      recovery.status === 'rejected' ||
      recovery.activeBrief === null
    )
      return;
    expect(recovery.activeBrief.path).toBe('tasks.md');
    expect(recovery.matchingReport?.report.path).toBe('brief-quality.json');
  });

  it('returns a digest-bound read-only error without rewriting future bytes', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: SESSION_ID };
    const state = { ...makeLegacyV3State('future-state'), stateVersion: 5 };
    const stateDir = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID);
    mkdirSync(stateDir, { recursive: true });
    const statePath = join(stateDir, 'state.json');
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const before = readFileSync(statePath);
    const result = loadStateForResume({
      ref,
      authority: {
        kind: 'read-only',
        permit: {
          kind: 'read-only-permit',
          sessionId: SESSION_ID,
          acquisitionId: 'acquisition-future',
          rawStateDigest: digest(before.toString('utf8')),
        },
      },
    });

    expect(result).toMatchObject({ kind: 'invalid', code: 'future-version' });
    expect(readFileSync(statePath)).toEqual(before);
  });

  it('commits v3 promotion and the first fence through one synchronous CAS', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: SESSION_ID };
    saveState(ref, makeLegacyV3State('fenced-promotion'));
    const result = commitStateAuthorityFence({
      ref,
      candidate: {
        kind: 'candidate',
        sessionId: SESSION_ID,
        ownerId: 'owner-1',
        pid: process.pid,
        processStart: 'test-start',
        runId: 'run-1',
        acquisitionId: 'acquisition-fence',
        fence: 0,
        stateRevision: 0,
        stateDigest: null,
      },
      nextFence: 1,
    });

    expect(result.kind).toBe('fenced');
    if (result.kind !== 'fenced') return;
    expect(result.promotedFromVersion).toBe(3);
    expect(result.receipt.fence).toBe(1);
    expect(loadState(ref)?.stateVersion).toBe(4);
  });
});
