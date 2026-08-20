import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  commitStateAuthorityFence,
  loadStateForResume,
  mapV3StateToV4,
  parseLegacyWorkflowState,
  saveState,
  loadState,
} from './persistence.js';
import { createInitialState } from './machine.js';
import { taskId } from '../schemas/task.js';
import type { NormalBriefRecoveryV1 } from '../schemas/brief-recovery.js';
import type { QueuedMessage } from '../schemas/workflow.js';
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

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function legacyState(feature = 'legacy-feature') {
  const current = createInitialState(feature);
  return {
    ...current,
    stateVersion: 3,
    phase: 'reviewing-briefs' as const,
    currentTaskIndex: 0,
    tasks: [],
    mode: 'standard' as const,
    messageQueue: [],
  };
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

function legacyMessage(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id,
    text: `${id} text`,
    queuedAt: '2026-08-13T10:00:00.000Z',
    phase: 'reviewing-briefs',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
    origin: 'user-input',
    ...overrides,
  };
}

function migrateLegacyQueue(messageQueue: QueuedMessage[]): {
  state: ReturnType<typeof mapV3StateToV4>;
  recovery: NormalBriefRecoveryV1;
} {
  const state = parseLegacyWorkflowState({ ...legacyState('legacy-queue'), messageQueue });
  if (state === null) throw new Error('expected a valid v3 queue fixture');
  const migrated = mapV3StateToV4({
    ref: { projectDir: '/tmp/project', sessionId: SESSION_ID },
    state,
    briefBytes: Buffer.from('# Task Briefs\n'),
    reportBytes: Buffer.from(JSON.stringify({ version: 1, passed: true, score: 1, issues: [] })),
    ownerId: 'migration-owner',
    fence: 1,
    stateRevision: 1,
  });
  const recovery = migrated.briefRecovery;
  if (
    recovery === undefined ||
    recovery === null ||
    recovery.status === 'storage-blocked' ||
    recovery.status === 'rejected'
  ) {
    throw new Error('expected a normal migrated Brief recovery');
  }
  return { state: migrated, recovery };
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

describe('authority-bearing resume persistence', () => {
  it('keeps loadState strict while the resume seam migrates v3', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: SESSION_ID };
    saveState(ref, legacyState());
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
    const state = legacyState('legacy-artifacts');
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
    const state = { ...legacyState('future-state'), stateVersion: 5 };
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
    saveState(ref, legacyState('fenced-promotion'));
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

describe('v3 queue migration', () => {
  it('keeps an empty legacy queue empty', () => {
    const migrated = migrateLegacyQueue([]);

    expect(migrated.recovery.inputs).toEqual([]);
    expect(migrated.recovery.nextInputSequence).toBe(1);
    expect(migrated.state.messageQueue).toEqual([]);
  });

  it('migrates pending user input as queued typed feedback', () => {
    const migrated = migrateLegacyQueue([legacyMessage('pending')]);

    expect(migrated.recovery.inputs).toEqual([
      expect.objectContaining({
        inputId: 'pending',
        kind: 'feedback',
        source: 'typed',
        state: 'queued',
        appliedRevision: null,
        history: [expect.objectContaining({ state: 'queued' })],
      }),
    ]);
    expect(migrated.state.messageQueue).toEqual([]);
  });

  it('preserves a native-delivered message as applied history instead of replaying it', () => {
    const migrated = migrateLegacyQueue([
      legacyMessage('delivered', {
        deliveredViaNative: true,
        nativeDeliveryState: 'delivered',
      }),
    ]);

    expect(migrated.recovery.inputs).toEqual([
      expect.objectContaining({
        inputId: 'delivered',
        kind: 'native-injection',
        source: 'native-injection',
        state: 'applied',
        appliedRevision: 1,
        history: [
          expect.objectContaining({ state: 'queued' }),
          expect.objectContaining({ state: 'applied' }),
        ],
      }),
    ]);
    expect(migrated.state.messageQueue).toEqual([]);
  });

  it('keeps only explicitly pending entries queued in a mixed legacy history', () => {
    const migrated = migrateLegacyQueue([
      legacyMessage('pending'),
      legacyMessage('drained-clarification', {
        origin: 'clarification',
        question: 'Which database?',
        drainedAt: '2026-08-13T10:01:00.000Z',
      }),
      legacyMessage('delivered', {
        deliveredViaNative: true,
        nativeDeliveryState: 'delivered',
      }),
      legacyMessage('injecting', { nativeDeliveryState: 'injecting' }),
    ]);

    expect(migrated.recovery.inputs).toEqual([
      expect.objectContaining({ inputId: 'pending', source: 'typed', state: 'queued' }),
      expect.objectContaining({
        inputId: 'drained-clarification',
        source: 'interactive',
        state: 'applied',
      }),
      expect.objectContaining({
        inputId: 'delivered',
        source: 'native-injection',
        state: 'applied',
      }),
      expect.objectContaining({
        inputId: 'injecting',
        source: 'native-injection',
        state: 'held',
      }),
    ]);
    expect(migrated.recovery.inputs.filter((input) => input.state === 'queued')).toHaveLength(1);
    expect(migrated.state.messageQueue).toEqual([]);
  });
});
