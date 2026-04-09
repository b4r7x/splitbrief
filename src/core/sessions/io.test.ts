import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessions, getSessionDir } from './io.js';
import { TINY_SPEC_DIR } from '../paths.js';

const TMP = join(import.meta.dirname, '.tmp-sessions-test');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeSession(overrides: Record<string, unknown> = {}) {
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
    expect(listSessions(join(TMP, 'does-not-exist'))).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const dir = join(TMP, 'empty');
    mkdirSync(dir, { recursive: true });
    expect(listSessions(dir)).toEqual([]);
  });

  it('parses session JSON files', () => {
    const dir = join(TMP, 'parse');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-1.json'), JSON.stringify(makeSession({ id: 'sess-1', feature: 'auth' })));

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('sess-1');
    expect(sessions[0]?.feature).toBe('auth');
  });

  it('sorts sessions by startedAt descending', () => {
    const dir = join(TMP, 'sorted');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), JSON.stringify(makeSession({ id: 'old', startedAt: 1000 })));
    writeFileSync(join(dir, 'mid.json'), JSON.stringify(makeSession({ id: 'mid', startedAt: 2000 })));
    writeFileSync(join(dir, 'new.json'), JSON.stringify(makeSession({ id: 'new', startedAt: 3000 })));

    const sessions = listSessions(dir);
    expect(sessions.map(s => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('limits to MAX_RECENT_SESSIONS (10)', () => {
    const dir = join(TMP, 'limited');
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
    const dir = join(TMP, 'malformed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), '{not valid json!!!');
    writeFileSync(join(dir, 'good.json'), JSON.stringify(makeSession({ id: 'good' })));

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('good');
  });

  it('ignores non-JSON files', () => {
    const dir = join(TMP, 'non-json');
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
