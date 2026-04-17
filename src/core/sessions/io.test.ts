import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessions, listAllSessions, getSessionDir, saveSummary } from './io.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/fixtures.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

import type { Session } from '../schemas/session.js';

function writeSessionSubdir(projectDir: string, sessionId: string, session: Session): void {
  const subdir = join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
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
    const sessionsRoot = join(tmp, DIPTYCH_DIR, SESSIONS_DIR);
    mkdirSync(sessionsRoot, { recursive: true });
    expect(listSessions(tmp)).toEqual([]);
  });

  it('parses summary.json files from subdirectories', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(tmp, '2024-01-01-auth', makeSession({ id: '2024-01-01-auth', feature: 'auth' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-auth');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('sorts sessions by startedAt descending', () => {
    tmp = createTempDir('sessions-io-test');
    writeSessionSubdir(tmp, '2024-01-01-old', makeSession({ id: '2024-01-01-old', startedAt: 1000 }));
    writeSessionSubdir(tmp, '2024-01-02-mid', makeSession({ id: '2024-01-02-mid', startedAt: 2000 }));
    writeSessionSubdir(tmp, '2024-01-03-new', makeSession({ id: '2024-01-03-new', startedAt: 3000 }));

    const sessions = listSessions(tmp);
    expect(sessions.map(s => s.id)).toEqual(['2024-01-03-new', '2024-01-02-mid', '2024-01-01-old']);
  });

  it('limits to MAX_RECENT_SESSIONS (10)', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 15; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(10);
    expect(sessions[0]?.startedAt).toBe(14000);
    expect(sessions[9]?.startedAt).toBe(5000);
  });

  it('skips subdirectories missing summary.json', () => {
    tmp = createTempDir('sessions-io-test');
    const emptySubdir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-empty');
    mkdirSync(emptySubdir, { recursive: true });
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('skips malformed JSON files gracefully', () => {
    tmp = createTempDir('sessions-io-test');
    const badDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), '{not valid json!!!');
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('skips valid JSON with invalid schema', () => {
    tmp = createTempDir('sessions-io-test');
    const badDir = join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'summary.json'), JSON.stringify({ id: 'x' }));
    writeSessionSubdir(tmp, '2024-01-02-good', makeSession({ id: '2024-01-02-good' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-02-good');
  });

  it('ignores non-directory entries', () => {
    tmp = createTempDir('sessions-io-test');
    const sessionsRoot = join(tmp, DIPTYCH_DIR, SESSIONS_DIR);
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(join(sessionsRoot, 'notes.txt'), 'not a session');
    writeSessionSubdir(tmp, '2024-01-01-valid', makeSession({ id: '2024-01-01-valid' }));

    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-valid');
  });
});

describe('listAllSessions', () => {
  it('returns all sessions without limit', () => {
    tmp = createTempDir('sessions-io-test');
    for (let i = 0; i < 15; i++) {
      const id = `2024-01-01-sess-${i}`;
      writeSessionSubdir(tmp, id, makeSession({ id, startedAt: i * 1000 }));
    }

    const sessions = listAllSessions(tmp);
    expect(sessions).toHaveLength(15);
  });
});

describe('getSessionDir', () => {
  it('returns project-scope path', () => {
    const dir = getSessionDir('project', '/my/project');
    expect(dir).toBe(join('/my/project', DIPTYCH_DIR, 'sessions'));
  });

  it('returns global-scope path', () => {
    const dir = getSessionDir('global', '/my/project');
    expect(dir).toBe(join(homedir(), DIPTYCH_DIR, 'sessions'));
  });
});

describe('saveSummary', () => {
  it('writes session summary.json to per-session subdirectory', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-1' });
    saveSummary(tmp, '2024-01-01-save-1', session);
    const raw = readFileSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-save-1', 'summary.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(session);
  });

  it('creates directory if it does not exist', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-2' });
    saveSummary(tmp, '2024-01-01-save-2', session);
    const raw = readFileSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-save-2', 'summary.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(session);
  });

  it('sets 0o600 file permissions', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-save-3' });
    saveSummary(tmp, '2024-01-01-save-3', session);
    const stats = statSync(join(tmp, DIPTYCH_DIR, SESSIONS_DIR, '2024-01-01-save-3', 'summary.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('validates session data and throws on invalid', () => {
    tmp = createTempDir('sessions-io-test');
    const invalid = { id: 'bad', feature: 123 };
    expect(() => saveSummary(tmp, 'bad', invalid as never)).toThrow('Invalid session data');
  });

  it('round-trips through listSessions', () => {
    tmp = createTempDir('sessions-io-test');
    const session = makeSession({ id: '2024-01-01-rt-1', feature: 'roundtrip', startedAt: 5000 });
    saveSummary(tmp, '2024-01-01-rt-1', session);
    const sessions = listSessions(tmp);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('2024-01-01-rt-1');
    expect(sessions[0]?.feature).toBe('roundtrip');
  });
});
