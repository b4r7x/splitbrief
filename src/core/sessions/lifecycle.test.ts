import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readActive,
  writeActive,
  clearActive,
  isSessionLive,
  generateSessionId,
} from './lifecycle.js';
import { DIPTYCH_DIR, LOCKFILE } from '../paths.js';
import { sessionDir } from '../paths.js';
import { STATE_FILE } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../state/machine.js';
import { currentProcessStartTimeMs, HEARTBEAT_STALENESS_MS } from './lockfile-status.js';

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
  overrides: Record<string, unknown> = {},
): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(
    join(sDir, LOCKFILE),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      startTimeMs: currentProcessStartTimeMs(),
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'standard',
      feature: 'feature',
      ...overrides,
    }),
  );
}

describe('writeActive / readActive round-trip', () => {
  it('writes and reads back the session id', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-my-feature' });
    expect(readActive(dir)).toBe('2026-04-14-my-feature');
  });

  it('trims trailing newline', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    expect(readActive(dir)).toBe('2026-04-14-feature');
  });

  it('rejects invalid session ids', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    expect(() => writeActive({ projectDir: dir, sessionId: '../outside' })).toThrow(
      'Invalid session id',
    );
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
  it('deletes the active file when the pointer names the given session', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    clearActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    expect(readActive(dir)).toBeNull();
  });

  it('is a no-op if active file does not exist', () => {
    const dir = makeTmp();
    expect(() => clearActive({ projectDir: dir, sessionId: '2026-04-14-feature' })).not.toThrow();
  });

  it('preserves the pointer when it names a different session (compare-and-clear ownership)', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.diptych'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-session-b' });

    // A stale cleanup from session A must not delete a pointer now owned by session B.
    clearActive({ projectDir: dir, sessionId: '2026-04-14-session-a' });

    expect(readActive(dir)).toBe('2026-04-14-session-b');
  });
});

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

  it('returns true for a lockfile-less session in implementing phase', () => {
    const dir = makeTmp();
    writeState(dir, '2026-04-14-implementing', 'implementing');
    expect(isSessionLive({ projectDir: dir, sessionId: '2026-04-14-implementing' })).toBe(true);
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

function mkSessionDir(projectDir: string, id: string): void {
  mkdirSync(join(projectDir, DIPTYCH_DIR, 'sessions', id), { recursive: true });
}

describe('generateSessionId', () => {
  it('formats date as YYYY-MM-DD with feature slug', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00Z'));
    expect(id).toBe('2026-04-14-add-email-validator');
  });

  it('appends -2 on first collision', () => {
    const dir = makeTmp();
    mkSessionDir(dir, '2026-04-14-add-email-validator');
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00Z'));
    expect(id).toBe('2026-04-14-add-email-validator-2');
  });

  it('appends -3 on second collision', () => {
    const dir = makeTmp();
    mkSessionDir(dir, '2026-04-14-add-email-validator');
    mkSessionDir(dir, '2026-04-14-add-email-validator-2');
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00Z'));
    expect(id).toBe('2026-04-14-add-email-validator-3');
  });

  it('reduces non-alphanumeric characters to hyphens (Polish diacritics)', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Dodaj walidację e-mail', new Date('2026-04-14T00:00:00Z'));
    expect(id).toBe('2026-04-14-dodaj-walidacj-e-mail');
  });

  it('falls back to slug "unknown" for an all-non-Latin (CJK) feature', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, '機能を追加', new Date('2026-04-14T00:00:00Z'));
    expect(id).toBe('2026-04-14-unknown');
  });

  it('reduces emoji and special chars to hyphens', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, '🚀 Launch rocket! 🎉', new Date('2026-04-14T00:00:00Z'));
    expect(id).not.toContain('🚀');
    expect(id).not.toContain('🎉');
    expect(id).toMatch(/^2026-04-14-[a-z0-9-]+$/);
  });

  it('truncates slug to 50 characters', () => {
    const dir = makeTmp();
    const longFeature =
      'this is a very long feature description that exceeds fifty characters easily';
    const id = generateSessionId(dir, longFeature, new Date('2026-04-14T00:00:00Z'));
    const slug = id.slice('2026-04-14-'.length);
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('collapses multiple non-alphanumeric chars into single hyphen', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add--email  validator', new Date('2026-04-14T00:00:00Z'));
    expect(id).toBe('2026-04-14-add-email-validator');
  });

  it('strips leading and trailing hyphens from slug', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, '---feature---', new Date('2026-04-14T00:00:00Z'));
    expect(id).toBe('2026-04-14-feature');
  });

  it('stamps the UTC calendar date even when the instant falls on a different local day', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-15T02:00:00Z'));
    expect(id).toBe('2026-04-15-add-email-validator');
  });

  it('stamps a single-digit month and day with zero padding', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-01-05T23:30:00Z'));
    expect(id).toBe('2026-01-05-add-email-validator');
  });
});
