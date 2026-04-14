import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readActive, writeActive, clearActive, isSessionLive } from './active.js';
import { sessionDir } from '../paths.js';
import { STATE_FILE } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../state/machine.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('active-test');
  return tmp;
}

describe('writeActive / readActive round-trip', () => {
  it('writes and reads back the session id', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive(dir, '2026-04-14-my-feature');
    expect(readActive(dir)).toBe('2026-04-14-my-feature');
  });

  it('trims trailing newline', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive(dir, '2026-04-14-feature');
    expect(readActive(dir)).toBe('2026-04-14-feature');
  });
});

describe('readActive', () => {
  it('returns null when active file does not exist', () => {
    const dir = makeTmp();
    expect(readActive(dir)).toBeNull();
  });

  it('returns null for empty file', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeFileSync(join(dir, '.diptych', 'active'), '');
    expect(readActive(dir)).toBeNull();
  });
});

describe('clearActive', () => {
  it('deletes the active file', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive(dir, '2026-04-14-feature');
    clearActive(dir);
    expect(readActive(dir)).toBeNull();
  });

  it('is a no-op if active file does not exist', () => {
    const dir = makeTmp();
    expect(() => clearActive(dir)).not.toThrow();
  });
});

describe('isSessionLive', () => {
  it('returns false when session folder does not exist', () => {
    const dir = makeTmp();
    expect(isSessionLive(dir, '2026-04-14-nonexistent')).toBe(false);
  });

  it('returns false for session in complete phase', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-done');
    mkdirSync(sDir, { recursive: true });
    const state = { ...createInitialState('done'), phase: 'complete' };
    writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
    expect(isSessionLive(dir, '2026-04-14-done')).toBe(false);
  });

  it('returns false for session in idle phase', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-idle');
    mkdirSync(sDir, { recursive: true });
    const state = createInitialState('idle');
    writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
    expect(isSessionLive(dir, '2026-04-14-idle')).toBe(false);
  });

  it('returns true for session in implementing phase', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-implementing');
    mkdirSync(sDir, { recursive: true });
    const state = { ...createInitialState('feature'), phase: 'implementing' };
    writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
    expect(isSessionLive(dir, '2026-04-14-implementing')).toBe(true);
  });

  it('returns false when state.json is corrupt', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-corrupt');
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, STATE_FILE), '{bad json!!!');
    expect(isSessionLive(dir, '2026-04-14-corrupt')).toBe(false);
  });
});
