import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  listRecentSessions,
  listSessions,
  listAllSessions,
  saveSummary,
  readSession,
} from './io.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';
import { saveState, loadState } from '../state/persistence.js';
import { isResumable } from '../phases.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
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

  it('returns every stored session newest first with total = count', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 35; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const recent = listRecentSessions(tmp);
    const sessions = listSessions(tmp);
    const all = listAllSessions(tmp);

    expect(recent.sessions).toHaveLength(35);
    expect(recent.total).toBe(35);
    expect(recent.sessions[0]?.startedAt).toBe(34000);
    expect(recent.sessions[34]?.startedAt).toBe(0);
    expect(recent.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 35 }, (_, i) => `2024-01-01-sess-${34 - i}`),
    );
    expect(sessions).toHaveLength(35);
    expect(all).toHaveLength(35);
    expect(sessions).toEqual(recent.sessions);
    expect(all).toEqual(recent.sessions);
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
      tool: 'deepseek',
      model: 'deepseek-chat',
    };
    const secondRow = {
      taskId: taskId('T002'),
      taskTitle: 'second task',
      method: 'local' as const,
      implementerTokens: 300_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'deepseek',
      model: 'deepseek-chat',
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
      tool: 'deepseek',
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

describe('crashed-run recovery from state.json', () => {
  it('lists a summary-less session that has a state.json as interrupted and resumable', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-crashed';
    const state = makeImplState([makeTask()], { feature: 'crashed-feature' });
    saveState({ projectDir: tmp, sessionId }, state);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, 'summary.json'))).toBe(
      false,
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(sessionId);
    expect(sessions[0]?.feature).toBe('crashed-feature');
    expect(sessions[0]?.status).toBe('interrupted');
    expect(sessions[0]?.summary).toBeNull();

    const recovered = loadState({ projectDir: tmp, sessionId });
    expect(recovered).not.toBeNull();
    expect(recovered && isResumable(recovered)).toBe(true);
  });

  it('prefers summary.json over state.json when both exist', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionId = '2024-01-01-both';
    saveState({ projectDir: tmp, sessionId }, makeImplState([makeTask()]));
    saveSummary(
      { projectDir: tmp, sessionId },
      makeSession({ id: sessionId, status: 'complete', feature: 'finished' }),
    );

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('complete');
    expect(sessions[0]?.feature).toBe('finished');
  });
});
