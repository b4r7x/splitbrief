import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { readActiveRecord } from './active-pointer.js';
import { inspectSessionLiveness, isSessionLive } from './liveness.js';
import { LOCKFILE, sessionDir, STATE_FILE } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../state/machine.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { HEARTBEAT_STALENESS_MS, type SessionLockStatus } from './lockfile-status.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('active-test');
  return tmp;
}

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

function livenessDeps(
  sessionId: string,
  lock: SessionLockStatus,
  active: ReturnType<typeof readActiveRecord> = { kind: 'legacy', sessionId },
) {
  return {
    readPhase: () => 'implementing' as const,
    readActive: () => active,
    checkLock: () => lock,
  };
}

describe('isSessionLive', () => {
  it('returns false when session folder does not exist', () => {
    const dir = makeTmp();
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-nonexistent' })).toBe(false);
  });

  it('returns false for session in complete phase', () => {
    const dir = makeTmp();
    writeState(dir, '2026-04-14-done', 'complete');
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-done' })).toBe(false);
  });

  it('returns false for session in idle phase', () => {
    const dir = makeTmp();
    writeState(dir, '2026-04-14-idle', 'idle');
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-idle' })).toBe(false);
  });

  it('returns false for a lockfile-less session in implementing phase', () => {
    const dir = makeTmp();
    writeState(dir, '2026-04-14-implementing', 'implementing');
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-implementing' })).toBe(false);
  });

  it('returns false for an implementing session whose lockfile has exited', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-exited';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId, { exitedAt: Date.now(), exitCode: 0 });

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(false);
  });

  it('returns false for an implementing session whose lockfile is invalid', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-invalid-lockfile';
    writeState(dir, sessionId, 'implementing');
    const sDir = sessionDir(dir, sessionId);
    writeFileSync(join(sDir, LOCKFILE), JSON.stringify({ version: 1, sessionId }));

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(false);
  });

  it('returns false for an implementing session whose lockfile names another session', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-mismatched-lockfile';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId, { sessionId: '2026-04-14-other-session' });

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(false);
  });

  it('returns false for an implementing session whose lockfile pid is gone', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-dead-pid';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId, { pid: 99999999 });

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(false);
  });

  it('returns false for an implementing session whose heartbeat is stale', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-stale-heartbeat';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId, {
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(false);
  });

  it('returns false for an implementing session when the pid was reused', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-reused-pid';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId, {
      pid: process.pid,
      startTimeMs: 1,
    });

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(false);
  });

  it('returns true for an implementing session with a live lockfile pid', () => {
    const dir = makeTmp();
    const sessionId = '2026-04-14-live-pid';
    writeState(dir, sessionId, 'implementing');
    writeLockfile(dir, sessionId);

    expect(isSessionLive({ projectDir: dir, sessionId })).toBe(true);
  });

  it('returns false when state.json is corrupt', () => {
    const dir = makeTmp();
    const sDir = sessionDir(dir, '2026-04-14-corrupt');
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, STATE_FILE), '{bad json!!!');
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-corrupt' })).toBe(false);
  });

  it('rejects invalid session ids before reading state', () => {
    const dir = makeTmp();
    expect(() => isSessionLive({ projectDir: dir, sessionId: '../outside' })).toThrow(
      'Invalid session id',
    );
  });
});

describe('inspectSessionLiveness', () => {
  it('reports a stale heartbeat without permitting takeover from age alone', () => {
    const sessionId = '2026-04-14-heartbeat-only';
    const ref = { projectDir: '/diagnostic-only', sessionId };
    const lock = {
      kind: 'stale',
      data: makeSessionLockfile(sessionId, { lastAliveMs: 0 }),
      processAlive: true,
    } satisfies SessionLockStatus;

    const result = inspectSessionLiveness(ref, livenessDeps(sessionId, lock));

    expect(result).toMatchObject({
      live: false,
      takeoverMayBeAttempted: false,
      heartbeat: 'stale',
      reason: 'heartbeat-stale',
    });
  });
});
