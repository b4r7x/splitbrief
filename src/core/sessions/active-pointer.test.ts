import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
} from './active-pointer.js';
import { inspectSessionLiveness } from './liveness.js';
import { HEARTBEAT_STALENESS_MS } from './lockfile-status.js';
import { LOCKFILE, sessionDir, STATE_FILE } from '../paths.js';
import { createInitialState } from '../state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

function makeTmp(): string {
  tmp = createTempDir('active-test');
  return tmp;
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

  it('names the active file, not its temporary copy, when the write of that copy fails', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, '.splitbrief'), { recursive: true });
    writeActive({ projectDir: dir, sessionId: '2026-04-14-existing' });

    expect(() =>
      writeActive(
        { projectDir: dir, sessionId: '2026-04-14-replacement' },
        {
          _beforeMutation: (boundary) => {
            if (boundary !== 'write-permissions') return;
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
              syscall: 'write',
            });
          },
        },
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'ENOSPC', path: join(dir, '.splitbrief', 'active') }),
    );
    expect(readActive(dir)).toBe('2026-04-14-existing');
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

function writeOwner(
  projectDir: string,
  sessionId: string,
  lock: Parameters<typeof makeSessionLockfile>[1],
): void {
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, STATE_FILE),
    JSON.stringify({ ...createInitialState('feature'), phase: 'implementing' }),
  );
  writeFileSync(join(dir, LOCKFILE), JSON.stringify(makeSessionLockfile(sessionId, lock)));
}

function writeCompetingPointer(projectDir: string, sessionId: string, kind: 'legacy' | 'v1'): void {
  if (kind === 'legacy') writeActive({ projectDir, sessionId });
  else reactivateExistingSession({ projectDir, sessionId });
}

const resumeOptions = { inspectOwner: inspectSessionLiveness };

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

  it.each(['legacy', 'v1'] as const)(
    'takes over a %s pointer whose owner process is dead',
    (kind) => {
      const dir = makeTmp();
      const owner = '2026-04-14-dead-owner';
      writeOwner(dir, owner, { pid: 99999999 });
      writeCompetingPointer(dir, owner, kind);

      const receipt = reactivateExistingSession(
        { projectDir: dir, sessionId: '2026-04-14-resume' },
        resumeOptions,
      );

      expect(receipt.sessionId).toBe('2026-04-14-resume');
      expect(readActiveRecord(dir)).toEqual({ kind: 'v1', receipt });
    },
  );

  it.each([
    ['live', {}],
    ['stale', { lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1 }],
    ['unknown', null],
  ] as const)('refuses to take over a pointer whose owner is %s', (_label, lock) => {
    const dir = makeTmp();
    const ownerId = '2026-04-14-owner';
    if (lock !== null) writeOwner(dir, ownerId, lock);
    for (const kind of ['legacy', 'v1'] as const) {
      rmSync(join(dir, '.splitbrief', 'active'), { force: true });
      writeCompetingPointer(dir, ownerId, kind);
      const before = readActiveRecord(dir);

      expect(() =>
        reactivateExistingSession(
          { projectDir: dir, sessionId: '2026-04-14-resume' },
          resumeOptions,
        ),
      ).toThrowError(expect.objectContaining({ kind: 'session-still-active' }));
      expect(readActiveRecord(dir)).toEqual(before);
    }
  });

  it('refuses when the competing receipt is replaced between inspection and mutation', () => {
    const dir = makeTmp();
    const owner = { projectDir: dir, sessionId: '2026-04-14-dead-owner' };
    writeOwner(dir, owner.sessionId, { pid: 99999999 });
    reactivateExistingSession(owner);
    const newer = {
      version: 1 as const,
      sessionId: owner.sessionId,
      generation: '33333333-3333-4333-8333-333333333333',
    };

    expect(() =>
      reactivateExistingSession(
        { projectDir: dir, sessionId: '2026-04-14-resume' },
        {
          inspectOwner: (ref) => {
            const result = inspectSessionLiveness(ref);
            writeFileSync(join(dir, '.splitbrief', 'active'), `${JSON.stringify(newer)}\n`);
            return result;
          },
        },
      ),
    ).toThrowError(expect.objectContaining({ kind: 'active-mutation-conflict' }));
    expect(readActiveRecord(dir)).toEqual({ kind: 'v1', receipt: newer });
  });

  it('keeps stale generations from clearing the ownership that replaced them', () => {
    const dir = makeTmp();
    const owner = { projectDir: dir, sessionId: '2026-04-14-dead-owner' };
    const resume = { projectDir: dir, sessionId: '2026-04-14-resume' };
    writeOwner(dir, owner.sessionId, { pid: 99999999 });
    const displaced = reactivateExistingSession(owner);

    const first = reactivateExistingSession(resume, resumeOptions);
    const current = reactivateExistingSession(resume, resumeOptions);

    expect(clearActiveReceipt(owner, displaced)).toBe(false);
    expect(clearActiveReceipt(resume, first)).toBe(false);
    expect(readActiveRecord(dir)).toEqual({ kind: 'v1', receipt: current });
    expect(clearActiveReceipt(resume, current)).toBe(true);
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
