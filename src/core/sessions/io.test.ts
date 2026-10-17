import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listSessions, saveSummary, readSession } from './io.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';
import { saveState } from '../state/persistence.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { taskId } from '../schemas/task.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

import type { Session } from '../schemas/session.js';

function writeSessionSubdir(projectDir: string, sessionId: string, session: Session): void {
  const subdir = join(projectDir, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId);
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, 'summary.json'), JSON.stringify(session));
}

describe('listSessions', () => {
  it('returns empty array when sessions directory does not exist', () => {
    tmp = createTempDir('sessions-io-test');
    expect(listSessions(join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('returns empty array when sessions directory is empty', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionsRoot = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR);
    mkdirSync(sessionsRoot, { recursive: true });
    expect(listSessions(tmp)).toEqual([]);
  });

  it('parses summary.json files from subdirectories', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(
      tmp,
      '2024-01-01-auth',
      makeSession({ id: '2024-01-01-auth', feature: 'auth' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-auth');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('uses the directory id when summary payload id differs', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(
      tmp,
      '2024-01-01-real',
      makeSession({ id: '2024-01-01-other', feature: 'auth' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-real');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('skips session directories with invalid ids', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(tmp, '.invalid', makeSession({ id: '.invalid', startedAt: 3000 }));
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions.map((s) => s.id)).toEqual(['2024-01-02-good']);
  });

  it('sorts sessions by startedAt descending', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(
      tmp,
      '2024-01-01-old',
      makeSession({ id: '2024-01-01-old', startedAt: 1000 }),
    );
    writeSessionSubdir(
      tmp,
      '2024-01-02-mid',
      makeSession({ id: '2024-01-02-mid', startedAt: 2000 }),
    );
    writeSessionSubdir(
      tmp,
      '2024-01-03-new',
      makeSession({ id: '2024-01-03-new', startedAt: 3000 }),
    );

    const sessions = listSessions(tmp);
    expect(sessions.map((s) => s.id)).toEqual([
      '2024-01-03-new',
      '2024-01-02-mid',
      '2024-01-01-old',
    ]);
  });

  it('returns every stored session newest first', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 35; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const sessions = listSessions(tmp);

    expect(sessions).toHaveLength(35);
    expect(sessions[0]?.startedAt).toBe(34000);
    expect(sessions[34]?.startedAt).toBe(0);
    expect(sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 35 }, (_, i) => `2024-01-01-sess-${34 - i}`),
    );
  });

  it('skips subdirectories with neither summary.json nor a recoverable state.json', () => {
    tmp = createTempDir('sessions-io-test');
    const emptySubdir = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-empty');
    mkdirSync(emptySubdir, { recursive: true });
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('skips sessions with malformed summary.json and returns only the valid ones', () => {
    tmp = createTempDir('sessions-io-test');
    const badDir = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), '{not valid json!!!');
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('skips valid JSON with invalid schema', () => {
    tmp = createTempDir('sessions-io-test');
    const badDir = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), JSON.stringify({ id: 'x' }));
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('ignores non-directory entries', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionsRoot = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR);
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, 'notes.txt'), 'not a session');
    writeSessionSubdir(tmp, '2024-01-01-valid', makeSession({ id: '2024-01-01-valid' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-valid');
  });
});

describe('saveSummary', () => {
  it('creates the session directory and writes summary.json', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-1' });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-save-1' }, session);
    const path = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-save-1', 'summary.json');
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-save-1'))).toBe(true);
    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-save-1' })).toEqual(session);
    const stats = statSync(path);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('validates session data and throws on invalid', () => {
    tmp = createTempDir('sessions-io-test');
    const invalid = { id: 'bad', feature: 123 };
    expect(() => saveSummary({ projectDir: tmp, sessionId: 'bad' }, invalid as never)).toThrow(
      'Invalid session data',
    );
  });

  it('rejects mismatched path id and summary payload id', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-real' });
    expect(() => saveSummary({ projectDir: tmp, sessionId: '2024-01-01-other' }, session)).toThrow(
      "Cannot save session summary for '2024-01-01-other'",
    );
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-other'))).toBe(false);
  });

  it('rejects invalid session ids', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '../outside' });
    expect(() => saveSummary({ projectDir: tmp, sessionId: '../outside' }, session)).toThrow(
      'Invalid session id',
    );
  });

  it('round-trips through listSessions with complete session and taskBreakdown rows', () => {
    tmp = createTempDir('sessions-io-test');
    const id = '2024-01-01-breakdown';
    const firstRow = {
      taskId: taskId('T001'),
      taskTitle: 'first task',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'custom-endpoint',
      model: 'acme/reasoner-1',
    };
    const secondRow = {
      taskId: taskId('T002'),
      taskTitle: 'second task',
      method: 'local' as const,
      implementerTokens: 300_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'custom-endpoint',
      model: 'acme/reasoner-1',
    };

    const session = makeSession({
      id,
      feature: 'roundtrip',
      startedAt: 5000,
      status: 'complete',
      summary: makeSummary({ taskBreakdown: [firstRow, secondRow] }),
    });
    saveSummary({ projectDir: tmp, sessionId: id }, session);

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(id);
    expect(sessions[0]?.feature).toBe('roundtrip');
    const breakdown = sessions[0]?.summary?.taskBreakdown ?? [];
    expect(breakdown.map((row) => row.taskId)).toEqual([taskId('T001'), taskId('T002')]);
    expect(breakdown.find((row) => row.taskId === taskId('T001'))).toMatchObject({
      implementerTokens: 500_000,
      tool: 'custom-endpoint',
    });
  });
});

describe('readSession', () => {
  it('readSession returns the summary saved by saveSummary', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-read-1', feature: 'read-me' });
    saveSummary({ projectDir: tmp, sessionId: '2024-01-01-read-1' }, session);

    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-read-1' })).toEqual(session);
  });

  it('readSession returns null for a missing or invalid record', () => {
    tmp = createTempDir('sessions-io-test');
    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-missing' })).toBeNull();

    const badDir = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, '2024-01-01-invalid');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), JSON.stringify({ id: 'x' }));
    expect(readSession({ projectDir: tmp, sessionId: '2024-01-01-invalid' })).toBeNull();
  });
});

describe('rows derived from state.json', () => {
  it('lists a summary-less session that has a state.json as open, with its phase', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-crashed';
    const state = makeImplState([makeTask()], { feature: 'crashed-feature', mode: 'standard' });
    saveState({ projectDir: tmp, sessionId }, state);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, 'summary.json'))).toBe(
      false,
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      feature: 'crashed-feature',
      status: 'open',
      stop: 'stopped',
      phase: 'implementing',
    });
    expect(sessions[0]).not.toHaveProperty('mode');
    expect(sessions[0]?.summary).toBeNull();
  });

  it('lists a run ready to apply as open, ready to apply, with no stop', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-ready';
    saveState(
      { projectDir: tmp, sessionId },
      makeImplState([makeTask()], {
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: { kind: 'worktree', path: '/tmp/wt', base: { snapshotId: 'b', head: null } },
      }),
    );

    const row = listSessions(tmp)[0];
    expect(row?.status).toBe('open');
    expect(row?.apply).toBe('ready');
    expect(row).not.toHaveProperty('stop');
  });

  it.each([
    ['applied', 'ended'],
    ['discarded', 'ended'],
  ] as const)('lists a run closed as %s with its Apply outcome', (as, status) => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = `2024-01-01-${as}`;
    saveState(
      { projectDir: tmp, sessionId },
      makeImplState([makeTask()], {
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: { kind: 'worktree', path: '/tmp/wt', base: { snapshotId: 'b', head: null } },
        closed: { at: '2024-01-01T00:00:00.000Z', as },
      }),
    );

    expect(listSessions(tmp)[0]).toMatchObject({ status, apply: as });
  });

  it('lists a run whose Apply was undone as undone, not applied', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-undone';
    saveState(
      { projectDir: tmp, sessionId },
      makeImplState([makeTask()], {
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: { kind: 'worktree', path: '/tmp/wt', base: { snapshotId: 'b', head: null } },
        closed: { at: '2024-01-01T00:00:00.000Z', as: 'applied' },
        applied: {
          at: '2024-01-01T00:00:00.000Z',
          backupId: 'backup',
          files: ['src/a.ts'],
          undone: { at: '2024-01-01T00:01:00.000Z', conflicts: [] },
        },
      }),
    );

    expect(listSessions(tmp)[0]).toMatchObject({ status: 'ended', apply: 'undone' });
  });

  it('names a halted run as waiting for you', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-halted';
    saveState(
      { projectDir: tmp, sessionId },
      makeImplState([makeTask({ id: 'T001' })], {
        phase: 'validating-task',
        pendingRecovery: makeRecoveryIssue(),
      }),
    );

    expect(listSessions(tmp)[0]).toMatchObject({ status: 'open', stop: 'waiting-for-you' });
  });

  it('derives the status from the state even when a summary.json is present', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-both';
    saveState(
      { projectDir: tmp, sessionId },
      makeImplState([makeTask()], { phase: 'complete', reviewStatus: 'passed' }),
    );
    saveSummary(
      { projectDir: tmp, sessionId },
      makeSession({ id: sessionId, status: 'complete', feature: 'finished' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('complete');
    expect(sessions[0]?.feature).toBe('finished');
  });

  it('keeps the recorded status of a run whose state no longer loads', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-legacy';
    writeSessionSubdir(
      tmp,
      sessionId,
      makeSession({ id: sessionId, status: 'complete', feature: 'legacy-complete' }),
    );

    expect(listSessions(tmp)[0]?.status).toBe('complete');
  });

  it('lists a legacy summary.json written with an interrupted status as open', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-legacy-open';
    const subdir = join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId);
    mkdirSync(subdir, { recursive: true });
    writeFileSync(
      join(subdir, 'summary.json'),
      JSON.stringify({
        id: sessionId,
        feature: 'legacy feature',
        startedAt: 1000,
        completedAt: 2000,
        stateVersion: 4,
        status: 'interrupted',
        summary: null,
      }),
    );

    expect(listSessions(tmp)[0]).toMatchObject({ status: 'open', feature: 'legacy feature' });
  });
});
