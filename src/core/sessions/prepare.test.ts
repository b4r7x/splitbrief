import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { lockSibling } from '../../lib/file-lock.js';
import { activeFile, LOCKFILE, READINESS_FILE, sessionDir, STATE_FILE } from '../paths.js';
import { createInitialState } from '../state/machine.js';
import { readActive, writeActive, type PreparedNewSession } from './active-pointer.js';
import {
  createSessionPreparationCandidate,
  prepareNewSession,
  releasePreparedSession,
  rollbackPreparedSession,
  type PrepareNewSessionInput,
  type SessionMutationBoundary,
} from './prepare.js';

const tempDirs: string[] = [];
const OWNERSHIP_FILE = '.prepare-owner.json';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function projectDir(): string {
  const dir = createTempDir('prepare-session');
  tempDirs.push(dir);
  return dir;
}

function preparedSession(input: PrepareNewSessionInput): PreparedNewSession {
  const result = prepareNewSession(input);
  if (result.kind !== 'prepared') {
    throw new Error(`expected a prepared session, got ${result.kind}`);
  }
  return result.session;
}

function prepareInput(
  project: string,
  sessionId: string,
  signal: AbortSignal,
): PrepareNewSessionInput {
  return {
    projectDir: project,
    feature: 'remember runner readiness',
    config: makeConfig(),
    report: {
      generatedAt: '2026-08-03T18:00:00.000Z',
      projectDir: project,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [
        {
          id: 'runners',
          title: 'Runners',
          checks: [{ id: 'runners.available', severity: 'ok', summary: 'Ready' }],
        },
      ],
      metadata: {},
    },
    signal,
    candidate: createSessionPreparationCandidate({
      projectDir: project,
      feature: 'remember runner readiness',
      sessionId,
    }),
  };
}

function writeInterruptedState(project: string, sessionId: string): void {
  writeFileSync(
    join(sessionDir(project, sessionId), STATE_FILE),
    JSON.stringify({ ...createInitialState('interrupted run'), phase: 'implementing' }),
  );
}

function replaceSessionDirectory(project: string, sessionId: string): void {
  const directory = sessionDir(project, sessionId);
  const displaced = `${directory}.displaced`;
  renameSync(directory, displaced);
  mkdirSync(directory);
  writeFileSync(join(directory, 'foreign-owner'), 'preserve me');
}

describe('prepareNewSession', () => {
  it('creates a validated candidate without creating its session path', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-candidate-only';

    const candidate = createSessionPreparationCandidate({
      projectDir: project,
      feature: 'candidate only',
      sessionId,
    });

    expect(candidate).toMatchObject({
      version: 1,
      sessionId,
      generation: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
  });

  it('holds the project mutation lock from final ownership validation through active publication and rollback', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-one-lock';
    const lock = lockSibling(activeFile(project));
    let publishLocked = false;
    let rollbackLocked = false;
    const session = preparedSession({
      ...prepareInput(project, sessionId, new AbortController().signal),
      _beforeMutation: (boundary) => {
        if (boundary === 'active') publishLocked = existsSync(lock);
      },
    });

    rollbackPreparedSession(session, {
      _beforeMutation: (boundary) => {
        if (boundary === 'directory-claim') rollbackLocked = existsSync(lock);
      },
    });

    expect(publishLocked).toBe(true);
    expect(rollbackLocked).toBe(true);
    expect(readActive(project)).toBeNull();
    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
  });

  it('persists readiness before publishing the active session', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-ready-first';
    const readinessPath = join(sessionDir(project, sessionId), READINESS_FILE);
    const controller = new AbortController();
    let readinessBeforeActive: boolean | null = null;
    let activeBeforeActive: string | null | undefined;

    const result = prepareNewSession({
      ...prepareInput(project, sessionId, controller.signal),
      _beforeMutation: (boundary) => {
        if (boundary !== 'active') return;
        readinessBeforeActive = existsSync(readinessPath);
        activeBeforeActive = readActive(project);
      },
    });

    expect(readinessBeforeActive).toBe(true);
    expect(activeBeforeActive).toBeNull();

    expect(result).toMatchObject({
      kind: 'prepared',
      session: {
        ref: { projectDir: project, sessionId },
        ownership: { version: 1, sessionId },
        active: { version: 1, sessionId },
      },
    });
    if (result.kind !== 'prepared') return;
    expect(result.session.active).toBe(result.session.ownership);
    expect(readFileSync(activeFile(project), 'utf8')).toBe(
      `${JSON.stringify(result.session.ownership)}\n`,
    );
    expect(readActive(project)).toBe(sessionId);
    expect(JSON.parse(readFileSync(readinessPath, 'utf8'))).toMatchObject({
      type: 'start-readiness',
      generatedAt: '2026-08-03T18:00:00.000Z',
      status: 'ready',
    });
    expect(
      JSON.parse(readFileSync(join(sessionDir(project, sessionId), OWNERSHIP_FILE), 'utf8')),
    ).toEqual({
      version: 1,
      sessionId,
      generation: result.session.ownership.generation,
      dev: expect.stringMatching(/^\d+$/),
      ino: expect.stringMatching(/^\d+$/),
    });
  });

  it('a stale `.splitbrief/active` does not block `prepareExecution`/`prepareNewSession` for a new workflow', () => {
    const project = projectDir();
    const signal = new AbortController().signal;
    const interrupted = '2026-08-03-interrupted';
    const fresh = '2026-08-03-after-interrupt';
    expect(prepareNewSession(prepareInput(project, interrupted, signal)).kind).toBe('prepared');
    writeInterruptedState(project, interrupted);

    const result = prepareNewSession(prepareInput(project, fresh, signal));

    expect(result.kind).toBe('prepared');
    expect(readActive(project)).toBe(fresh);
    expect(existsSync(sessionDir(project, interrupted))).toBe(true);
  });

  it('refuses to publish over a live session and leaves its active pointer intact', () => {
    const project = projectDir();
    const signal = new AbortController().signal;
    const live = '2026-08-03-live-run';
    const attempted = '2026-08-03-blocked-by-live';
    expect(prepareNewSession(prepareInput(project, live, signal)).kind).toBe('prepared');
    writeInterruptedState(project, live);
    writeFileSync(
      join(sessionDir(project, live), LOCKFILE),
      JSON.stringify(makeSessionLockfile(live)),
    );

    expect(() => prepareNewSession(prepareInput(project, attempted, signal))).toThrow();

    expect(readActive(project)).toBe(live);
    expect(existsSync(sessionDir(project, attempted))).toBe(false);
  });

  it('rolls back only the owned session when aborted at each mutation boundary', () => {
    const boundaries: readonly SessionMutationBoundary[] = ['allocation', 'readiness', 'active'];

    for (const boundaryToAbort of boundaries) {
      const project = projectDir();
      const foreignSessionId = `2026-08-03-foreign-${boundaryToAbort}`;
      const attemptedSessionId = `2026-08-03-attempt-${boundaryToAbort}`;
      mkdirSync(sessionDir(project, foreignSessionId), { recursive: true });
      writeActive({ projectDir: project, sessionId: foreignSessionId });
      const controller = new AbortController();

      const result = prepareNewSession({
        ...prepareInput(project, attemptedSessionId, controller.signal),
        _beforeMutation: (boundary) => {
          if (boundary === boundaryToAbort) controller.abort();
        },
      });

      expect(result).toEqual({ kind: 'aborted' });
      expect(readActive(project)).toBe(foreignSessionId);
      expect(existsSync(sessionDir(project, foreignSessionId))).toBe(true);
      expect(existsSync(sessionDir(project, attemptedSessionId))).toBe(false);
    }
  });

  it('treats rollback before candidate directory creation as an idempotent no-op', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-same-active';
    writeActive({ projectDir: project, sessionId });
    const ownership = createSessionPreparationCandidate({
      projectDir: project,
      feature: 'unused candidate',
      sessionId: '2026-08-03-absent-candidate',
    });

    expect(() =>
      rollbackPreparedSession({
        ref: { projectDir: project, sessionId: ownership.sessionId },
        ownership,
      }),
    ).not.toThrow();

    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(sessionDir(project, ownership.sessionId))).toBe(false);
  });

  it('aborts under the final mutation lock without publishing active state', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-final-abort';
    const controller = new AbortController();

    const result = prepareNewSession({
      ...prepareInput(project, sessionId, controller.signal),
      _beforeMutation: (boundary) => {
        if (boundary === 'active') controller.abort();
      },
    });

    expect(result).toEqual({ kind: 'aborted' });
    expect(readActive(project)).toBeNull();
    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
  });

  it('does not write or delete a replacement introduced at the readiness boundary', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-replaced-readiness';
    const controller = new AbortController();
    let caught: unknown;

    try {
      prepareNewSession({
        ...prepareInput(project, sessionId, controller.signal),
        _beforeMutation: (boundary) => {
          if (boundary === 'readiness') replaceSessionDirectory(project, sessionId);
        },
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'write-readiness', sessionId },
    });
    expect(existsSync(join(sessionDir(project, sessionId), 'foreign-owner'))).toBe(true);
    expect(existsSync(join(sessionDir(project, sessionId), READINESS_FILE))).toBe(false);
    expect(readActive(project)).toBeNull();
  });

  it('fails closed and preserves a replacement introduced before abort cleanup', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-replaced-abort';
    const controller = new AbortController();
    let caught: unknown;

    try {
      prepareNewSession({
        ...prepareInput(project, sessionId, controller.signal),
        _beforeMutation: (boundary) => {
          if (boundary !== 'readiness') return;
          replaceSessionDirectory(project, sessionId);
          controller.abort();
        },
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'rollback-session', sessionId },
    });
    expect(existsSync(join(sessionDir(project, sessionId), 'foreign-owner'))).toBe(true);
    expect(readActive(project)).toBeNull();
  });

  it('does not publish active for a replacement introduced at the active boundary', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-replaced-active';
    const controller = new AbortController();
    let caught: unknown;

    try {
      prepareNewSession({
        ...prepareInput(project, sessionId, controller.signal),
        _beforeMutation: (boundary) => {
          if (boundary === 'active') replaceSessionDirectory(project, sessionId);
        },
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'publish-active', sessionId },
    });
    expect(readActive(project)).toBeNull();
    expect(existsSync(join(sessionDir(project, sessionId), 'foreign-owner'))).toBe(true);
  });

  it('a late attempt cannot clear a newer active session', () => {
    const project = projectDir();
    const signal = new AbortController().signal;
    const older = prepareNewSession(prepareInput(project, '2026-08-03-older', signal));
    expect(older.kind).toBe('prepared');
    if (older.kind !== 'prepared') return;
    const newerSessionId = '2026-08-03-newer';
    writeFileSync(
      activeFile(project),
      `${JSON.stringify({
        version: 1,
        sessionId: newerSessionId,
        generation: '44444444-4444-4444-8444-444444444444',
      })}\n`,
      { mode: 0o600 },
    );

    rollbackPreparedSession(older.session);

    expect(readActive(project)).toBe(newerSessionId);
    expect(existsSync(sessionDir(project, older.session.ref.sessionId))).toBe(false);
  });

  it('public rollback refuses to clear active or delete a replacement directory', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-replaced-rollback';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));
    replaceSessionDirectory(project, sessionId);

    let caught: unknown;
    try {
      rollbackPreparedSession(session);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'rollback-session', sessionId },
    });
    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(join(sessionDir(project, sessionId), 'foreign-owner'))).toBe(true);
  });

  it('validates the ownership marker as untrusted input before rollback', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-invalid-owner';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));

    writeFileSync(
      join(sessionDir(project, sessionId), OWNERSHIP_FILE),
      JSON.stringify({ version: 1, sessionId, dev: '1', ino: '2', unexpected: true }),
    );

    expect(() => rollbackPreparedSession(session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );
    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(sessionDir(project, sessionId))).toBe(true);
  });

  it('rolls back from durable ownership proof after module state is reset', async () => {
    const project = projectDir();
    const sessionId = '2026-08-03-cold-rollback';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));

    vi.resetModules();
    const coldModule = await import('./prepare.js');
    coldModule.rollbackPreparedSession({
      ref: session.ref,
      ownership: session.ownership,
    });

    expect(readActive(project)).toBeNull();
    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
  });

  it('releases durable ownership without changing session artifacts or active state', async () => {
    const project = projectDir();
    const sessionId = '2026-08-03-released';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));
    const directory = sessionDir(project, sessionId);
    const readinessPath = join(directory, READINESS_FILE);
    const readiness = readFileSync(readinessPath, 'utf8');

    vi.resetModules();
    const coldReleaseModule = await import('./prepare.js');
    const ownership = { ref: session.ref, ownership: session.ownership };
    coldReleaseModule.releasePreparedSession(ownership);

    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(readinessPath, 'utf8')).toBe(readiness);
    expect(existsSync(join(directory, OWNERSHIP_FILE))).toBe(false);

    vi.resetModules();
    const coldRollbackModule = await import('./prepare.js');
    expect(() => coldRollbackModule.rollbackPreparedSession(ownership)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );
    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(readinessPath, 'utf8')).toBe(readiness);
    expect(existsSync(join(directory, OWNERSHIP_FILE))).toBe(false);
  });

  it('release validates ownership and removes the marker under one project mutation lock', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-release-one-lock';
    const session = preparedSession(prepareInput(project, sessionId, new AbortController().signal));
    const marker = join(sessionDir(project, sessionId), OWNERSHIP_FILE);
    const lock = lockSibling(activeFile(project));
    let releaseLocked = false;

    releasePreparedSession(session, {
      _beforeMutation: (boundary) => {
        if (boundary === 'ownership-claim') releaseLocked = existsSync(lock);
      },
    });

    expect(releaseLocked).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readActive(project)).toBe(sessionId);
  });

  it('a stale same-session generation cannot release clear or delete a newer generation', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-generation-aba';
    const session = preparedSession(prepareInput(project, sessionId, new AbortController().signal));
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const newerGeneration = '55555555-5555-4555-8555-555555555555';
    const newerProof = {
      ...JSON.parse(readFileSync(marker, 'utf8')),
      generation: newerGeneration,
    };
    writeFileSync(marker, `${JSON.stringify(newerProof)}\n`, { mode: 0o600 });
    writeFileSync(
      activeFile(project),
      `${JSON.stringify({ version: 1, sessionId, generation: newerGeneration })}\n`,
      { mode: 0o600 },
    );

    expect(() => releasePreparedSession(session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'release-session', sessionId },
      }),
    );
    expect(() => rollbackPreparedSession(session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );
    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain(newerGeneration);
    expect(
      readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
        name.includes('.directory.'),
      ),
    ).toEqual([]);
  });

  it('refuses to release ownership when the session directory was replaced', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-replaced-release';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));
    const marker = join(sessionDir(project, sessionId), OWNERSHIP_FILE);
    const proof = readFileSync(marker, 'utf8');
    replaceSessionDirectory(project, sessionId);
    writeFileSync(marker, proof, { mode: 0o600 });

    expect(() => releasePreparedSession(session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'release-session', sessionId },
      }),
    );
    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(join(sessionDir(project, sessionId), 'foreign-owner'))).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(proof);
  });

  it('does not release a same-byte ownership marker replaced after validation', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-replaced-marker-release';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));
    const marker = join(sessionDir(project, sessionId), OWNERSHIP_FILE);
    const displaced = `${marker}.displaced`;
    const proof = readFileSync(marker, 'utf8');

    expect(() =>
      releasePreparedSession(session, {
        _beforeMutation: (boundary) => {
          if (boundary !== 'ownership-claim') return;
          renameSync(marker, displaced);
          writeFileSync(marker, proof, { mode: 0o600 });
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'release-session', sessionId },
      }),
    );

    expect(readFileSync(marker, 'utf8')).toBe(proof);
    expect(readFileSync(displaced, 'utf8')).toBe(proof);
    expect(readActive(project)).toBe(sessionId);
  });

  it('fails release when a newer marker appears after the original is claimed', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-marker-after-claim';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const proof = readFileSync(marker, 'utf8');

    expect(() =>
      releasePreparedSession(session, {
        _beforeMutation: (boundary) => {
          if (boundary === 'ownership-captured') {
            writeFileSync(marker, proof, { mode: 0o600 });
          }
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'release-session', sessionId },
      }),
    );

    expect(readFileSync(marker, 'utf8')).toBe(proof);
    expect(
      readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
        name.includes('.owner.'),
      ),
    ).toHaveLength(1);
    expect(existsSync(directory)).toBe(true);
    expect(readActive(project)).toBe(sessionId);
  });

  it('preserves a foreign directory in quarantine when it replaces the owned claim target', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-terminal-directory-replacement';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));

    expect(() =>
      rollbackPreparedSession(session, {
        _beforeMutation: (boundary) => {
          if (boundary === 'directory-claim') replaceSessionDirectory(project, sessionId);
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );

    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
    expect(existsSync(`${sessionDir(project, sessionId)}.displaced`)).toBe(true);
    const quarantines = readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
      name.includes('.directory.'),
    );
    expect(quarantines).toHaveLength(1);
    expect(
      existsSync(join(project, '.splitbrief', 'sessions', quarantines[0]!, 'foreign-owner')),
    ).toBe(true);
  });

  it('leaves quarantine intact when the canonical directory is concurrently recreated', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-recreated-after-claim';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));

    expect(() =>
      rollbackPreparedSession(session, {
        _beforeMutation: (boundary) => {
          if (boundary !== 'directory-captured') return;
          mkdirSync(sessionDir(project, sessionId));
          writeFileSync(join(sessionDir(project, sessionId), 'foreign-owner'), 'preserve me');
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );

    expect(readActive(project)).toBe(sessionId);
    expect(existsSync(join(sessionDir(project, sessionId), 'foreign-owner'))).toBe(true);
    expect(
      readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
        name.includes('.directory.'),
      ),
    ).toHaveLength(1);
  });

  it('preserves the owned session when active cleanup fails before directory removal', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-active-cleanup-failure';
    const signal = new AbortController().signal;
    const session = preparedSession(prepareInput(project, sessionId, signal));
    const directory = sessionDir(project, sessionId);
    const readinessPath = join(directory, READINESS_FILE);
    const readiness = readFileSync(readinessPath, 'utf8');
    rmSync(activeFile(project));
    mkdirSync(activeFile(project));

    expect(() => rollbackPreparedSession(session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(readinessPath, 'utf8')).toBe(readiness);
    expect(existsSync(join(directory, OWNERSHIP_FILE))).toBe(true);
  });

  it('preserves an existing readiness record and returns structured write failure', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-existing-readiness';
    const readinessPath = join(sessionDir(project, sessionId), READINESS_FILE);
    const existing = '{"source":"another-owner"}\n';
    const controller = new AbortController();
    const input = prepareInput(project, sessionId, controller.signal);
    const ownership = input.candidate;
    if (ownership === undefined) throw new Error('Preparation candidate fixture is missing');
    let caught: unknown;

    try {
      prepareNewSession({
        ...input,
        _beforeMutation: (boundary) => {
          if (boundary === 'readiness') writeFileSync(readinessPath, existing);
        },
      });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'write-readiness', sessionId },
    });
    expect(readFileSync(readinessPath, 'utf8')).toBe(existing);
    expect(readActive(project)).toBeNull();
    expect(existsSync(join(sessionDir(project, sessionId), OWNERSHIP_FILE))).toBe(false);
    expect(() =>
      rollbackPreparedSession({
        ref: { projectDir: project, sessionId },
        ownership,
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );
    expect(readFileSync(readinessPath, 'utf8')).toBe(existing);
  });
});
