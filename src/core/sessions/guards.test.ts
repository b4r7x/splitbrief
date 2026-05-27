import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearStaleSession } from './guards.js';
import { writeActive } from './lifecycle.js';
import { activeFile, sessionDir, STATE_FILE, DIPTYCH_DIR } from '../paths.js';
import { createInitialState } from '../state/machine.js';
import { sessionError } from './errors.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tmp: string;

function makeTmp(): string {
  tmp = createTempDir('guards-test');
  mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
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

  it('clears the active pointer when the referenced session never persisted state', () => {
    const dir = makeTmp();
    // Session id points to a folder that does not exist — treated as not-live.
    writeActive({ projectDir: dir, sessionId: '2026-04-18-phantom' });

    clearStaleSession(dir);

    expect(existsSync(activeFile(dir))).toBe(false);
  });

  it('throws a CLI error when the referenced session is still in progress', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-18-in-progress';
    writeState(dir, sessionId, 'implementing');
    writeActive({ projectDir: dir, sessionId: sessionId });

    try {
      clearStaleSession(dir);
      throw new Error('expected clearStaleSession to throw');
    } catch (err) {
      expect(sessionError.isStillActive(err)).toBe(true);
      expect((err as Error).message).toContain(sessionId);
    }

    // The active pointer must be preserved — user has to decide between
    // `diptych resume` and manual deletion.
    expect(existsSync(activeFile(dir))).toBe(true);
  });

  it('does not touch an active pointer referencing a live session on repeated invocation', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-18-alive';
    writeState(dir, sessionId, 'planning');
    writeActive({ projectDir: dir, sessionId: sessionId });

    // First invocation throws, second still sees a live session and still throws.
    expect(() => clearStaleSession(dir)).toThrow();
    expect(() => clearStaleSession(dir)).toThrow();
    expect(existsSync(activeFile(dir))).toBe(true);
  });

  it('treats an idle-phase session as stale and clears it', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-18-idle';
    writeState(dir, sessionId, 'idle');
    writeActive({ projectDir: dir, sessionId: sessionId });

    clearStaleSession(dir);

    expect(existsSync(activeFile(dir))).toBe(false);
  });

  it('treats a corrupt state.json as stale (non-live) and clears the active pointer', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-18-corrupt';
    const sDir = sessionDir(dir, sessionId);
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, STATE_FILE), '{not valid json');
    writeActive({ projectDir: dir, sessionId: sessionId });

    clearStaleSession(dir);

    expect(existsSync(activeFile(dir))).toBe(false);
  });
});
