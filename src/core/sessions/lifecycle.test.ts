import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readActive,
  readActiveRecord,
  writeActive,
  clearActive,
  clearActiveReceipt,
  reactivateExistingSession,
  withSessionMutationLock,
  writeActiveReceiptLocked,
  inspectSessionLiveness,
  isSessionLive,
  generateSessionId,
  generateOpaqueSessionSlug,
  isOpaqueSessionId,
  featureForTranscriptPolicy,
  TRANSCRIPT_OMITTED_FEATURE,
} from './lifecycle.js';
import { SPLITBRIEF_DIR, LOCKFILE } from '../paths.js';
import { sessionDir } from '../paths.js';
import { STATE_FILE } from '../paths.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../state/machine.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { currentProcessStartTimeMs } from '../../lib/process/start-time.js';
import type { StateAuthorityReceipt } from '../state/types.js';
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

function makeAuthority(
  sessionId: string,
  overrides: Partial<StateAuthorityReceipt> = {},
): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: 'owner-1',
    pid: process.pid,
    processStart: String(Math.round(currentProcessStartTimeMs())),
    runId: 'run-1',
    acquisitionId: 'acquisition-1',
    fence: 1,
    stateRevision: 1,
    stateDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function livenessDeps(
  sessionId: string,
  lock: SessionLockStatus,
  authority: StateAuthorityReceipt | null,
  active: ReturnType<typeof readActiveRecord> = { kind: 'legacy', sessionId },
) {
  return {
    readPhase: () => 'implementing' as const,
    readActive: () => active,
    checkLock: () => lock,
    readAuthority: () => authority,
    assertAuthority: () => undefined,
  };
}

describe('writeActive / readActive round-trip', () => {
  it('writes and reads a newline-terminated active session ID', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-my-feature' });
    expect(readActive(dir)).toBe('2026-04-14-my-feature');
  });

  it('rejects invalid session ids', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    expect(() => writeActive({ projectDir: dir, sessionId: '../outside' })).toThrow(
      'Invalid session id',
    );
  });

  it('does not publish when permission finalization fails before commit', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-existing' });

    expect(() =>
      writeActive(
        { projectDir: dir, sessionId: '2026-04-14-replacement' },
        {
          _beforeMutation: (boundary) => {
            if (boundary === 'write-permissions') throw new Error('permission failure');
          },
        },
      ),
    ).toThrow('permission failure');

    expect(readActive(dir)).toBe('2026-04-14-existing');
    expect(readdirSync(join(dir, '.splitbrief')).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  it('does not overwrite a different active record introduced before commit', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    const active = join(dir, '.splitbrief', 'active');
    writeActive({ projectDir: dir, sessionId: '2026-04-14-existing' });

    expect(() =>
      writeActive(
        { projectDir: dir, sessionId: '2026-04-14-replacement' },
        {
          _beforeMutation: (boundary) => {
            if (boundary !== 'write-commit') return;
            renameSync(active, `${active}.old`);
            writeFileSync(active, '2026-04-14-foreign\n', { mode: 0o600 });
          },
        },
      ),
    ).toThrowError(expect.objectContaining({ kind: 'active-mutation-conflict' }));
    expect(readActive(dir)).toBe('2026-04-14-foreign');
  });
});

describe('readActive', () => {
  it('returns null when active file does not exist', () => {
    const dir = makeTmp();
    expect(readActive(dir)).toBeNull();
  });

  it('returns null for empty file', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeFileSync(join(dir, '.splitbrief', 'active'), '');
    expect(readActive(dir)).toBeNull();
  });
});

describe('reactivateExistingSession', () => {
  it('replaces same-session legacy and v1 state with a fresh active generation', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: '2026-04-14-resume' };
    writeActive(ref);

    const first = reactivateExistingSession(ref);
    const second = reactivateExistingSession(ref);

    expect(first.sessionId).toBe(ref.sessionId);
    expect(second.sessionId).toBe(ref.sessionId);
    expect(second.generation).not.toBe(first.generation);
    expect(readActiveRecord(dir)).toEqual({ kind: 'v1', receipt: second });
  });

  it('refuses to replace an active record for another session', () => {
    const dir = makeTmp();
    const active = { projectDir: dir, sessionId: '2026-04-14-other' };
    writeActive(active);

    expect(() =>
      reactivateExistingSession({ projectDir: dir, sessionId: '2026-04-14-resume' }),
    ).toThrowError(expect.objectContaining({ kind: 'active-mutation-conflict' }));
    expect(readActive(dir)).toBe(active.sessionId);
  });
});

describe('clearActive', () => {
  it('projects v1 active records while exact clear is generation bound and legacy write and clear fail closed', () => {
    const dir = makeTmp();
    const ref = { projectDir: dir, sessionId: '2026-04-14-prepared' };
    const receipt = {
      version: 1 as const,
      sessionId: ref.sessionId,
      generation: '11111111-1111-4111-8111-111111111111',
    };
    withSessionMutationLock(dir, () => writeActiveReceiptLocked(ref, receipt));

    expect(readActiveRecord(dir)).toEqual({ kind: 'v1', receipt });
    expect(readActive(dir)).toBe(ref.sessionId);
    expect(clearActive(ref)).toBe(false);
    expect(() => writeActive(ref)).toThrowError(
      expect.objectContaining({ kind: 'active-mutation-conflict' }),
    );
    expect(
      clearActiveReceipt(ref, {
        ...receipt,
        generation: '22222222-2222-4222-8222-222222222222',
      }),
    ).toBe(false);
    expect(readActiveRecord(dir)).toEqual({ kind: 'v1', receipt });
    expect(clearActiveReceipt(ref, receipt)).toBe(true);
    expect(readActive(dir)).toBeNull();
  });

  it('deletes the active file when the pointer names the given session', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    clearActive({ projectDir: dir, sessionId: '2026-04-14-feature' });
    expect(readActive(dir)).toBeNull();
  });

  it('is a no-op if active file does not exist', () => {
    const dir = makeTmp();
    expect(() => clearActive({ projectDir: dir, sessionId: '2026-04-14-feature' })).not.toThrow();
  });

  it('preserves an empty legacy active file as a non-matching pointer', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeFileSync(join(dir, '.splitbrief', 'active'), '');

    expect(() => clearActive({ projectDir: dir, sessionId: '2026-04-14-feature' })).not.toThrow();
    expect(readActive(dir)).toBeNull();
  });

  it('preserves the pointer when it names a different session (compare-and-clear ownership)', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-session-b' });

    // A stale cleanup from session A must not delete a pointer now owned by session B.
    clearActive({ projectDir: dir, sessionId: '2026-04-14-session-a' });

    expect(readActive(dir)).toBe('2026-04-14-session-b');
  });

  it('preserves a newer active pointer that replaces the snapshot before claim', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    const active = join(dir, '.splitbrief', 'active');
    writeActive({ projectDir: dir, sessionId: '2026-04-14-session-a' });

    expect(() =>
      clearActive(
        { projectDir: dir, sessionId: '2026-04-14-session-a' },
        {
          _beforeMutation: (boundary) => {
            if (boundary !== 'clear-claim') return;
            renameSync(active, `${active}.old`);
            writeFileSync(active, '2026-04-14-session-b\n', { mode: 0o600 });
          },
        },
      ),
    ).toThrow('active session changed');

    expect(readActive(dir)).toBe('2026-04-14-session-b');
  });

  it('does not clear a same-id active pointer with a newer inode', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    const active = join(dir, '.splitbrief', 'active');
    const ref = { projectDir: dir, sessionId: '2026-04-14-session-a' };
    writeActive(ref);

    expect(() =>
      clearActive(ref, {
        _beforeMutation: (boundary) => {
          if (boundary !== 'clear-claim') return;
          renameSync(active, `${active}.old`);
          writeFileSync(active, `${ref.sessionId}\n`, { mode: 0o600 });
        },
      }),
    ).toThrow('active session changed');

    expect(readActive(dir)).toBe(ref.sessionId);
  });

  it('preserves a newer active pointer published after the old pointer is claimed', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    const active = join(dir, '.splitbrief', 'active');
    const ref = { projectDir: dir, sessionId: '2026-04-14-session-a' };
    writeActive(ref);

    clearActive(ref, {
      _beforeMutation: (boundary) => {
        if (boundary === 'clear-captured') {
          writeFileSync(active, '2026-04-14-session-b\n', { mode: 0o600 });
        }
      },
    });

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
  it('keeps a stale heartbeat live when the authority is live and the pointer disagrees', () => {
    const sessionId = '2026-04-14-authority-live';
    const ref = { projectDir: '/diagnostic-only', sessionId };
    const lock = {
      kind: 'stale',
      data: makeSessionLockfile(sessionId, { lastAliveMs: 0 }),
      processAlive: true,
    } satisfies SessionLockStatus;
    const authority = makeAuthority(sessionId);
    const result = inspectSessionLiveness(
      ref,
      livenessDeps(sessionId, lock, authority, { kind: 'legacy', sessionId: '2026-04-14-other' }),
    );

    expect(result).toEqual({
      live: true,
      takeoverMayBeAttempted: false,
      authority: 'live',
      processIdentity: 'live',
      heartbeat: 'stale',
      activePointer: 'mismatched',
      reason: 'authority-live',
    });
  });

  it('allows a dead authority owner to be considered for takeover', () => {
    const sessionId = '2026-04-14-authority-dead';
    const ref = { projectDir: '/diagnostic-only', sessionId };
    const lock = {
      kind: 'live',
      data: makeSessionLockfile(sessionId),
    } satisfies SessionLockStatus;
    const authority = makeAuthority(sessionId, { pid: 2_147_483_646, processStart: '1' });

    const result = inspectSessionLiveness(ref, livenessDeps(sessionId, lock, authority));

    expect(result).toMatchObject({
      live: false,
      takeoverMayBeAttempted: true,
      authority: 'dead',
      processIdentity: 'dead',
      heartbeat: 'live',
      reason: 'authority-dead',
    });
  });

  it('reports pid reuse separately from a dead authority owner', () => {
    const sessionId = '2026-04-14-authority-reused';
    const ref = { projectDir: '/diagnostic-only', sessionId };
    const lock = {
      kind: 'live',
      data: makeSessionLockfile(sessionId),
    } satisfies SessionLockStatus;
    const authority = makeAuthority(sessionId, { processStart: '1' });

    const result = inspectSessionLiveness(ref, livenessDeps(sessionId, lock, authority));

    expect(result).toMatchObject({
      live: false,
      takeoverMayBeAttempted: true,
      authority: 'pid-reused',
      processIdentity: 'pid-reused',
      heartbeat: 'live',
      reason: 'authority-pid-reused',
    });
  });

  it('fails closed for malformed authority and never lets a stale heartbeat authorize takeover', () => {
    const sessionId = '2026-04-14-authority-invalid';
    const ref = { projectDir: '/diagnostic-only', sessionId };
    const lock = {
      kind: 'stale',
      data: makeSessionLockfile(sessionId, { lastAliveMs: 0 }),
      processAlive: true,
    } satisfies SessionLockStatus;

    const result = inspectSessionLiveness(ref, {
      ...livenessDeps(sessionId, lock, null),
      readAuthority: () => {
        throw new Error('symlinked authority receipt');
      },
      readActive: () => {
        throw new Error('symlinked active pointer');
      },
    });

    expect(result).toEqual({
      live: true,
      takeoverMayBeAttempted: false,
      authority: 'invalid',
      processIdentity: 'not-checked',
      heartbeat: 'stale',
      activePointer: 'invalid',
      reason: 'authority-invalid',
    });
  });

  it('reports a stale heartbeat without authority without permitting takeover from age alone', () => {
    const sessionId = '2026-04-14-heartbeat-only';
    const ref = { projectDir: '/diagnostic-only', sessionId };
    const lock = {
      kind: 'stale',
      data: makeSessionLockfile(sessionId, { lastAliveMs: 0 }),
      processAlive: true,
    } satisfies SessionLockStatus;

    const result = inspectSessionLiveness(ref, livenessDeps(sessionId, lock, null));

    expect(result).toMatchObject({
      live: false,
      takeoverMayBeAttempted: false,
      authority: 'missing',
      heartbeat: 'stale',
      reason: 'heartbeat-stale',
    });
  });
});

function mkSessionDir(projectDir: string, id: string): void {
  mkdirSync(join(projectDir, SPLITBRIEF_DIR, 'sessions', id), { recursive: true });
}

describe('generateSessionId', () => {
  it.each([
    {
      feature: 'Add email validator',
      isoDate: '2026-04-14T10:00:00Z',
      expectedId: '2026-04-14-add-email-validator',
    },
    {
      feature: 'Dodaj walidację e-mail',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-dodaj-walidacj-e-mail',
    },
    {
      feature: '機能を追加',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-unknown',
    },
    {
      feature: 'Add--email  validator',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-add-email-validator',
    },
    {
      feature: '---feature---',
      isoDate: '2026-04-14T00:00:00Z',
      expectedId: '2026-04-14-feature',
    },
    {
      feature: 'Add email validator',
      isoDate: '2026-04-15T02:00:00Z',
      expectedId: '2026-04-15-add-email-validator',
    },
    {
      feature: 'Add email validator',
      isoDate: '2026-01-05T23:30:00Z',
      expectedId: '2026-01-05-add-email-validator',
    },
  ])('builds $expectedId from feature and UTC date', ({ feature, isoDate, expectedId }) => {
    const dir = makeTmp();
    const id = generateSessionId(dir, feature, new Date(isoDate));
    expect(id).toBe(expectedId);
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

  it('generates an opaque id with no feature text when persistTranscript is false', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add secret oauth login', new Date('2026-04-14T10:00:00Z'), {
      persistTranscript: false,
    });
    expect(id).toMatch(/^2026-04-14-session-[a-f0-9]{12}$/);
    expect(isOpaqueSessionId(id)).toBe(true);
    expect(id).not.toContain('secret');
    expect(id).not.toContain('oauth');
  });

  it('keeps the feature slug when persistTranscript is true', () => {
    const dir = makeTmp();
    const id = generateSessionId(dir, 'Add email validator', new Date('2026-04-14T10:00:00Z'), {
      persistTranscript: true,
    });
    expect(id).toBe('2026-04-14-add-email-validator');
    expect(isOpaqueSessionId(id)).toBe(false);
  });
});

describe('transcript-policy session helpers', () => {
  it('mints opaque slugs that round-trip through isOpaqueSessionId', () => {
    const slug = generateOpaqueSessionSlug();
    expect(slug).toMatch(/^session-[a-f0-9]{12}$/);
    expect(isOpaqueSessionId(`2026-04-14-${slug}`)).toBe(true);
    expect(isOpaqueSessionId(`2026-04-14-${slug}-2`)).toBe(true);
  });

  it('treats a feature-derived id as non-opaque', () => {
    expect(isOpaqueSessionId('2026-04-14-add-email-validator')).toBe(false);
  });

  it('redacts the feature only when transcript persistence is off', () => {
    expect(featureForTranscriptPolicy('secret feature', true)).toBe('secret feature');
    expect(featureForTranscriptPolicy('secret feature', false)).toBe(TRANSCRIPT_OMITTED_FEATURE);
  });
});
