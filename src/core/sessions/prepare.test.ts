import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { lockSibling } from '../../lib/file-lock.js';
import { activeFile, READINESS_FILE, sessionDir } from '../paths.js';
import { readActive, writeActive } from './lifecycle.js';
import {
  acceptDetachedSessionHandoff,
  createSessionPreparationCandidate,
  prepareNewSession,
  releasePreparedSession,
  rollbackDetachedSessionHandoff,
  rollbackPreparedSession,
  settleDetachedSessionHandoff,
  transferPreparedSessionToDetached,
  type PrepareNewSessionInput,
  type SessionMutationBoundary,
} from './prepare.js';

const tempDirs: string[] = [];
const OWNERSHIP_FILE = '.prepare-owner.json';
const DETACHED_HANDOFF_FILE = '.detached-handoff.json';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function projectDir(): string {
  const dir = createTempDir('prepare-session');
  tempDirs.push(dir);
  return dir;
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
      persistTranscript: true,
      sessionId,
    }),
  };
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
      persistTranscript: true,
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
    const prepared = prepareNewSession({
      ...prepareInput(project, sessionId, new AbortController().signal),
      _beforeMutation: (boundary) => {
        if (boundary === 'active') publishLocked = existsSync(lock);
      },
    });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    rollbackPreparedSession(prepared.session, {
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

    const result = prepareNewSession({
      ...prepareInput(project, sessionId, controller.signal),
      _beforeMutation: (boundary) => {
        if (boundary !== 'active') return;
        expect(existsSync(readinessPath)).toBe(true);
        expect(readActive(project)).toBeNull();
      },
    });

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
      persistTranscript: true,
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    replaceSessionDirectory(project, sessionId);

    let caught: unknown;
    try {
      rollbackPreparedSession(prepared.session);
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    writeFileSync(
      join(sessionDir(project, sessionId), OWNERSHIP_FILE),
      JSON.stringify({ version: 1, sessionId, dev: '1', ino: '2', unexpected: true }),
    );

    expect(() => rollbackPreparedSession(prepared.session)).toThrowError(
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    vi.resetModules();
    const coldModule = await import('./prepare.js');
    coldModule.rollbackPreparedSession({
      ref: prepared.session.ref,
      ownership: prepared.session.ownership,
    });

    expect(readActive(project)).toBeNull();
    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
  });

  it('releases durable ownership without changing session artifacts or active state', async () => {
    const project = projectDir();
    const sessionId = '2026-08-03-released';
    const signal = new AbortController().signal;
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const readinessPath = join(directory, READINESS_FILE);
    const readiness = readFileSync(readinessPath, 'utf8');

    vi.resetModules();
    const coldReleaseModule = await import('./prepare.js');
    const ownership = { ref: prepared.session.ref, ownership: prepared.session.ownership };
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
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const marker = join(sessionDir(project, sessionId), OWNERSHIP_FILE);
    const lock = lockSibling(activeFile(project));
    let releaseLocked = false;

    releasePreparedSession(prepared.session, {
      _beforeMutation: (boundary) => {
        if (boundary === 'ownership-claim') releaseLocked = existsSync(lock);
      },
    });

    expect(releaseLocked).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readActive(project)).toBe(sessionId);
  });

  it('transfers exact rollback authority to a durable detached handoff before release', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-handoff';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);

    transferPreparedSessionToDetached(prepared.session);

    expect(existsSync(join(directory, OWNERSHIP_FILE))).toBe(true);
    expect(existsSync(join(directory, DETACHED_HANDOFF_FILE))).toBe(true);
    expect(() => rollbackPreparedSession(prepared.session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'rollback-session', sessionId },
      }),
    );

    expect(acceptDetachedSessionHandoff(prepared.session)).toBe(true);

    expect(existsSync(join(directory, OWNERSHIP_FILE))).toBe(false);
    expect(existsSync(join(directory, DETACHED_HANDOFF_FILE))).toBe(false);
    expect(existsSync(directory)).toBe(true);
    expect(readActive(project)).toBe(sessionId);
  });

  it('rolls back the exact detached handoff after the parent transfers ownership', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-handoff-rollback';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    transferPreparedSessionToDetached(prepared.session);
    rollbackDetachedSessionHandoff(prepared.session);

    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
    expect(readActive(project)).toBeNull();
  });

  it('leaves a canonical proof when the transfer process crashes after the atomic handoff', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-handoff-crash';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const script = `
      import { transferPreparedSessionToDetached } from ${JSON.stringify(new URL('./prepare.ts', import.meta.url).href)};
      const projectDir = process.env['SPLITBRIEF_TEST_HANDOFF_PROJECT'];
      const sessionId = process.env['SPLITBRIEF_TEST_HANDOFF_SESSION'];
      const generation = process.env['SPLITBRIEF_TEST_HANDOFF_GENERATION'];
      if (projectDir === undefined || sessionId === undefined || generation === undefined) process.exit(72);
      transferPreparedSessionToDetached(
        {
          ref: { projectDir, sessionId },
          ownership: { version: 1, sessionId, generation },
        },
        {
          _beforeMutation: (boundary) => {
            if (boundary === 'ownership-captured') process.exit(73);
          },
        },
      );
      process.exit(74);
    `;

    const crashed = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      env: {
        ...process.env,
        SPLITBRIEF_TEST_HANDOFF_PROJECT: project,
        SPLITBRIEF_TEST_HANDOFF_SESSION: sessionId,
        SPLITBRIEF_TEST_HANDOFF_GENERATION: prepared.session.ownership.generation,
      },
      stdio: 'pipe',
    });

    expect(crashed.status).toBe(73);
    expect(existsSync(join(sessionDir(project, sessionId), OWNERSHIP_FILE))).toBe(true);
    expect(existsSync(join(sessionDir(project, sessionId), DETACHED_HANDOFF_FILE))).toBe(true);

    rollbackDetachedSessionHandoff(prepared.session);
    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
    expect(readActive(project)).toBeNull();
  });

  it('atomically rolls back the original owner when detached handoff times out', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-handoff-timeout';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    expect(settleDetachedSessionHandoff(prepared.session)).toBe('rolled-back');

    expect(existsSync(sessionDir(project, sessionId))).toBe(false);
    expect(readActive(project)).toBeNull();
  });

  it.each([
    ['same-byte', false],
    ['new-generation', true],
  ] as const)('preserves a %s owner replacement during detached transfer', (_, newer) => {
    const project = projectDir();
    const sessionId = `2026-08-03-detached-owner-${newer ? 'newer' : 'same'}`;
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const original = readFileSync(marker, 'utf8');
    const replacement = newer
      ? `${JSON.stringify({
          ...JSON.parse(original),
          generation: '55555555-5555-4555-8555-555555555555',
        })}\n`
      : original;

    expect(() =>
      transferPreparedSessionToDetached(prepared.session, {
        _beforeMutation: (boundary) => {
          if (boundary !== 'ownership-claim') return;
          renameSync(marker, `${marker}.displaced`);
          writeFileSync(marker, replacement, { mode: 0o600 });
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'transfer-detached-session', sessionId },
      }),
    );
    expect(readFileSync(marker, 'utf8')).toBe(replacement);
    expect(readFileSync(`${marker}.displaced`, 'utf8')).toBe(original);
    const preserved = readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
      name.includes('.owner.'),
    );
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(project, '.splitbrief', 'sessions', preserved[0]!), 'utf8')).toBe(
      replacement,
    );
    expect(existsSync(join(directory, DETACHED_HANDOFF_FILE))).toBe(false);
  });

  it('preserves a handoff replacement claimed during failed transfer cleanup', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-recovery-replacement';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const handoff = join(directory, DETACHED_HANDOFF_FILE);
    const replacement = readFileSync(marker, 'utf8');

    expect(() =>
      transferPreparedSessionToDetached(prepared.session, {
        _beforeMutation: (boundary) => {
          if (boundary === 'ownership-claim') {
            renameSync(marker, `${marker}.displaced`);
            writeFileSync(marker, replacement, { mode: 0o600 });
          }
          if (boundary === 'detached-recovery-claim') {
            renameSync(handoff, `${handoff}.displaced`);
            writeFileSync(handoff, replacement, { mode: 0o600 });
          }
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'transfer-detached-session', sessionId },
      }),
    );

    expect(acceptDetachedSessionHandoff(prepared.session)).toBe(false);
    expect(existsSync(handoff)).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe(replacement);
    expect(readFileSync(`${handoff}.displaced`, 'utf8')).toBe(replacement);
    expect(
      readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
        name.includes('.owner.'),
      ),
    ).toHaveLength(1);
  });

  it('does not delete an owner replacement introduced immediately before alias cleanup', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-alias-replacement';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const handoff = join(directory, DETACHED_HANDOFF_FILE);
    const replacement = `${JSON.stringify({
      ...JSON.parse(readFileSync(marker, 'utf8')),
      generation: '55555555-5555-4555-8555-555555555555',
    })}\n`;
    transferPreparedSessionToDetached(prepared.session);

    expect(() =>
      acceptDetachedSessionHandoff(prepared.session, {
        _beforeMutation: (boundary) => {
          if (boundary !== 'detached-alias-claim') return;
          renameSync(marker, `${marker}.displaced`);
          writeFileSync(marker, replacement, { mode: 0o600 });
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'accept-detached-session', sessionId },
      }),
    );

    expect(existsSync(handoff)).toBe(true);
    expect(() => acceptDetachedSessionHandoff(prepared.session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'accept-detached-session', sessionId },
      }),
    );
    const preserved = readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
      name.includes('.owner.'),
    );
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(project, '.splitbrief', 'sessions', preserved[0]!), 'utf8')).toBe(
      replacement,
    );
  });

  it('accepts the exact committed handoff while preserving a later foreign owner', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-owner-after-link';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const replacement = `${JSON.stringify({
      ...JSON.parse(readFileSync(marker, 'utf8')),
      generation: '55555555-5555-4555-8555-555555555555',
    })}\n`;

    transferPreparedSessionToDetached(prepared.session, {
      _beforeMutation: (boundary) => {
        if (boundary !== 'ownership-captured') return;
        unlinkSync(marker);
        writeFileSync(marker, replacement, { mode: 0o600 });
      },
    });
    expect(acceptDetachedSessionHandoff(prepared.session)).toBe(true);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(directory, DETACHED_HANDOFF_FILE))).toBe(false);
    const preserved = readdirSync(join(project, '.splitbrief', 'sessions')).filter((name) =>
      name.includes('.owner.'),
    );
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(project, '.splitbrief', 'sessions', preserved[0]!), 'utf8')).toBe(
      replacement,
    );
    expect(readActive(project)).toBe(sessionId);
  });

  it('rejects handoff acceptance after a newer same-session activation', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-active-generation';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    transferPreparedSessionToDetached(prepared.session);
    writeFileSync(
      activeFile(project),
      `${JSON.stringify({
        version: 1,
        sessionId,
        generation: '55555555-5555-4555-8555-555555555555',
      })}\n`,
      { mode: 0o600 },
    );

    expect(() => acceptDetachedSessionHandoff(prepared.session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'accept-detached-session', sessionId },
      }),
    );
    expect(existsSync(join(sessionDir(project, sessionId), DETACHED_HANDOFF_FILE))).toBe(true);
  });

  it('keeps original rollback authority when detached transfer fails before publication', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-detached-handoff-failed';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);

    expect(() =>
      transferPreparedSessionToDetached(prepared.session, {
        _beforeMutation: (boundary) => {
          if (boundary === 'ownership-captured') throw new Error('stop before transfer');
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'transfer-detached-session', sessionId },
      }),
    );
    expect(existsSync(join(directory, OWNERSHIP_FILE))).toBe(true);
    expect(existsSync(join(directory, DETACHED_HANDOFF_FILE))).toBe(false);
    expect(acceptDetachedSessionHandoff(prepared.session)).toBe(false);

    rollbackPreparedSession(prepared.session);
    expect(existsSync(directory)).toBe(false);
  });

  it('a stale same-session generation cannot release clear or delete a newer generation', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-generation-aba';
    const prepared = prepareNewSession(
      prepareInput(project, sessionId, new AbortController().signal),
    );
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
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

    expect(() => releasePreparedSession(prepared.session)).toThrowError(
      expect.objectContaining({
        kind: 'session-prepare-io',
        data: { operation: 'release-session', sessionId },
      }),
    );
    expect(() => rollbackPreparedSession(prepared.session)).toThrowError(
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const marker = join(sessionDir(project, sessionId), OWNERSHIP_FILE);
    const proof = readFileSync(marker, 'utf8');
    replaceSessionDirectory(project, sessionId);
    writeFileSync(marker, proof, { mode: 0o600 });

    expect(() => releasePreparedSession(prepared.session)).toThrowError(
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const marker = join(sessionDir(project, sessionId), OWNERSHIP_FILE);
    const displaced = `${marker}.displaced`;
    const proof = readFileSync(marker, 'utf8');

    expect(() =>
      releasePreparedSession(prepared.session, {
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    const proof = readFileSync(marker, 'utf8');

    expect(() =>
      releasePreparedSession(prepared.session, {
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    expect(() =>
      rollbackPreparedSession(prepared.session, {
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;

    expect(() =>
      rollbackPreparedSession(prepared.session, {
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
    const prepared = prepareNewSession(prepareInput(project, sessionId, signal));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const directory = sessionDir(project, sessionId);
    const readinessPath = join(directory, READINESS_FILE);
    const readiness = readFileSync(readinessPath, 'utf8');
    rmSync(activeFile(project));
    mkdirSync(activeFile(project));

    expect(() => rollbackPreparedSession(prepared.session)).toThrowError(
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
