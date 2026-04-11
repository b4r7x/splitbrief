import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessions, getSessionDir, saveSession } from './io.js';
import { TINY_SPEC_DIR } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

import type { Session } from '../types/index.js';

function makeSession(overrides: Partial<Omit<Session, 'status' | 'summary'>> = {}): Session {
  return {
    id: 'sess-1',
    feature: 'test feature',
    startedAt: 1000,
    completedAt: null,
    status: 'interrupted',
    summary: null,
    stateVersion: 1,
    stateFile: null,
    ...overrides,
  };
}

describe('listSessions', () => {
  it('returns empty array for nonexistent directory', () => {
    tmp = createTempDir('sessions-io-test');
    expect(listSessions(join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'empty');
    mkdirSync(dir, { recursive: true });
    expect(listSessions(dir)).toEqual([]);
  });

  it('parses session JSON files', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'parse');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-1.json'), JSON.stringify(makeSession({ id: 'sess-1', feature: 'auth' })));

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('sess-1');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('sorts sessions by startedAt descending', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'sorted');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), JSON.stringify(makeSession({ id: 'old', startedAt: 1000 })));
    writeFileSync(join(dir, 'mid.json'), JSON.stringify(makeSession({ id: 'mid', startedAt: 2000 })));
    writeFileSync(join(dir, 'new.json'), JSON.stringify(makeSession({ id: 'new', startedAt: 3000 })));

    const sessions = listSessions(dir);
    expect(sessions.map(s => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('limits to MAX_RECENT_SESSIONS (10)', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'limited');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 15; i++) {
      writeFileSync(
        join(dir, `sess-${i}.json`),
        JSON.stringify(makeSession({ id: `sess-${i}`, startedAt: i * 1000 })),
      );
    }

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(10);
    expect(sessions[0]?.startedAt).toBe(14000);
    expect(sessions[9]?.startedAt).toBe(5000);
  });

  it('skips malformed JSON files gracefully', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'malformed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{not valid json!!!');
    writeFileSync(join(dir, 'good.json'), JSON.stringify(makeSession({ id: 'good' })));

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('good');
  });

  it('skips valid JSON with invalid schema', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'invalid-schema');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'x' }));
    writeFileSync(join(dir, 'good.json'), JSON.stringify(makeSession({ id: 'good' })));

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('good');
  });

  it('ignores non-JSON files', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'non-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'not a session');
    writeFileSync(join(dir, 'readme.md'), '# sessions');
    writeFileSync(join(dir, 'valid.json'), JSON.stringify(makeSession({ id: 'valid' })));

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('valid');
  });
});

describe('getSessionDir', () => {
  it('returns project-scope path', () => {
    const dir = getSessionDir('project', '/my/project');
    expect(dir).toBe(join('/my/project', TINY_SPEC_DIR, 'sessions'));
  });

  it('returns global-scope path', () => {
    const dir = getSessionDir('global', '/my/project');
    expect(dir).toBe(join(homedir(), TINY_SPEC_DIR, 'sessions'));
  });
});

describe('saveSession', () => {
  it('writes session JSON to disk', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-basic');
    const session = makeSession({ id: 'save-1' });
    saveSession(dir, session);
    const raw = readFileSync(join(dir, 'save-1.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(session);
  });

  it('creates directory if it does not exist', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-nested', 'deep');
    const session = makeSession({ id: 'save-2' });
    saveSession(dir, session);
    const raw = readFileSync(join(dir, 'save-2.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(session);
  });

  it('sets 0o600 file permissions', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-perms');
    const session = makeSession({ id: 'save-3' });
    saveSession(dir, session);
    const stats = statSync(join(dir, 'save-3.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('validates session data and throws on invalid', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-invalid');
    const invalid = { id: 'bad', feature: 123 };
    expect(() => saveSession(dir, invalid as never)).toThrow('Invalid session data');
  });

  it('rejects empty session id', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-empty-id');
    const session = makeSession({ id: '' });
    expect(() => saveSession(dir, session)).toThrow("Invalid session id ''");
  });

  it('rejects session id with path traversal', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-traversal');
    const session = makeSession({ id: '../evil' });
    expect(() => saveSession(dir, session)).toThrow("Invalid session id '../evil'");
  });

  it('rejects session id with forward slash', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-slash');
    const session = makeSession({ id: 'foo/bar' });
    expect(() => saveSession(dir, session)).toThrow("Invalid session id 'foo/bar'");
  });

  it('rejects session id with backslash', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-backslash');
    const session = makeSession({ id: 'foo\\bar' });
    expect(() => saveSession(dir, session)).toThrow("Invalid session id 'foo\\bar'");
  });

  it('round-trips through listSessions', () => {
    tmp = createTempDir('sessions-io-test');
    const dir = join(tmp, 'save-roundtrip');
    const session = makeSession({ id: 'rt-1', feature: 'roundtrip', startedAt: 5000 });
    saveSession(dir, session);
    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('rt-1');
    expect(sessions[0]?.feature).toBe('roundtrip');
  });
});
