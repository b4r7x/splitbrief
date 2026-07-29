import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearStaleSession } from './guards.js';
import { writeActive } from './lifecycle.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { activeFile, sessionDir, STATE_FILE, SPLITBRIEF_DIR, LOCKFILE } from '../paths.js';
import { createInitialState } from '../state/machine.js';

let tmp: string;

function makeTmp(): string {
  tmp = createTempDir('guards-test');
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function writeState(projectDir: string, sessionId: string, phase: string): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  const state = { ...createInitialState('feature'), phase };
  writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
}

function writeLockfile(
  projectDir: string,
  sessionId: string,
  overrides: Parameters<typeof makeSessionLockfile>[1] = {},
): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(join(sDir, LOCKFILE), JSON.stringify(makeSessionLockfile(sessionId, overrides)));
}

describe('clearStaleSession', () => {
  it('is a no-op when there is no active session recorded', () => {
    const dir = makeTmp();
    expect(() => clearStaleSession(dir)).not.toThrow();
    expect(existsSync(activeFile(dir))).toBe(false);
  });

  it('clears the active pointer when the referenced session is in a terminal phase', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-18-old-feature';
    writeState(dir, sessionId, 'complete');
    writeActive({ projectDir: dir, sessionId: sessionId });
    expect(existsSync(activeFile(dir))).toBe(true);

    clearStaleSession(dir);

    expect(existsSync(activeFile(dir))).toBe(false);
  });

  it('preserves an in-progress active pointer when the session lockfile process is live', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-18-live-pid';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId);
    writeActive({ projectDir: dir, sessionId });

    expect(() => clearStaleSession(dir)).toThrow();
    expect(existsSync(activeFile(dir))).toBe(true);
  });
});
