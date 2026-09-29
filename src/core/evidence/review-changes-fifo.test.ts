import { execFileSync } from 'node:child_process';
import { constants, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../paths-io.js';
import { sessionDir } from '../paths.js';
import { readReviewChanges, REVIEW_CHANGES_FILE } from './review-changes.js';

// The probe substitutes what openSync really opens: the artifact path stays a regular
// file for lstat, while the descriptor the read would use is a FIFO. readFds/closedFds
// pin down that the descriptor is validated before any read and always released.
const probe = vi.hoisted(() => ({
  watchPath: '',
  substituteAtOpen: '',
  openFlags: [] as number[],
  readFds: [] as number[],
  closedFds: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: unknown[]) => {
      const target = args[0];
      if (probe.watchPath !== '' && target === probe.watchPath && probe.substituteAtOpen !== '') {
        probe.openFlags.push(Number(args[1]));
        // Force O_NONBLOCK on the substituted FIFO so a regressed open fails the
        // flags assertion instead of stalling the worker.
        args[1] = Number(args[1]) | actual.constants.O_NONBLOCK;
        return (actual.openSync as (...a: unknown[]) => unknown)(
          probe.substituteAtOpen,
          ...args.slice(1),
        );
      }
      return (actual.openSync as (...a: unknown[]) => unknown)(...args);
    },
    readFileSync: (...args: unknown[]) => {
      if (typeof args[0] === 'number') probe.readFds.push(args[0]);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    },
    closeSync: (fd: unknown) => {
      probe.closedFds.push(Number(fd));
      return (actual.closeSync as (...a: unknown[]) => unknown)(fd);
    },
  };
});

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('review changes FIFO substitution', () => {
  const projects: string[] = [];

  afterEach(() => {
    probe.watchPath = '';
    probe.substituteAtOpen = '';
    probe.openFlags.length = 0;
    probe.readFds.length = 0;
    probe.closedFds.length = 0;
    for (const project of projects.splice(0)) cleanupTempDir(project);
  });

  function fixture(): { ref: { projectDir: string; sessionId: string }; path: string } {
    const projectDir = createTempDir('review-changes-fifo');
    projects.push(projectDir);
    const ref = { projectDir, sessionId: 'review-fifo' };
    ensureSessionDir(projectDir, ref.sessionId);
    const path = join(sessionDir(projectDir, ref.sessionId), REVIEW_CHANGES_FILE);
    writeFileSync(path, JSON.stringify({ version: 1, sessionId: ref.sessionId, changes: [] }));
    return { ref, path };
  }

  itUnix('refuses a FIFO substituted at the open without stalling or reading it', () => {
    const { ref, path } = fixture();
    const fifoPath = join(ref.projectDir, 'substituted.fifo');
    execFileSync('mkfifo', [fifoPath]);
    probe.watchPath = path;
    probe.substituteAtOpen = fifoPath;
    const readsBefore = probe.readFds.length;
    const closesBefore = probe.closedFds.length;

    let thrown: unknown;
    try {
      readReviewChanges(ref);
    } catch (err) {
      thrown = err;
    }

    expect(probe.openFlags).toHaveLength(1);
    const flags = probe.openFlags[0] ?? 0;
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect((thrown as { kind?: string }).kind).toBe('review-changes-invalid');
    expect(probe.readFds.length).toBe(readsBefore); // the read never begins
    expect(probe.closedFds.length).toBe(closesBefore + 1); // the descriptor still closes
  });

  itUnix('refuses a FIFO artifact path before opening it', () => {
    const { ref, path } = fixture();
    rmSync(path);
    execFileSync('mkfifo', [path]);

    let thrown: unknown;
    try {
      readReviewChanges(ref);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { kind?: string }).kind).toBe('review-changes-invalid');
  });
});
