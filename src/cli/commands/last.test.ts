import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lastCommand } from './last.js';
import type { LastDeps } from './last.js';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `splitbrief-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpProjects.push(dir);
  return dir;
}

function makeSessionWithLockfile(
  projectDir: string,
  sessionId: string,
  startTimeMs: number,
  extra: Record<string, unknown> = {},
): void {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs,
    lastAliveMs: startTimeMs + 1000,
    sessionId,
    mode: 'standard',
    feature: `feature-${sessionId}`,
    exitedAt: startTimeMs + 5000,
    ...extra,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function makeInteractiveSession(projectDir: string, sessionId: string, mtimeMs: number): void {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  const statePath = join(sessDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ feature: `feature-${sessionId}` }));
  const seconds = mtimeMs / 1000;
  utimesSync(statePath, seconds, seconds);
}

const tmpProjects: string[] = [];

function captureContinuation(): { deps: LastDeps; sessionIds: string[] } {
  const sessionIds: string[] = [];
  return {
    sessionIds,
    deps: {
      continueCommand: async (sessionId) => {
        sessionIds.push(sessionId ?? '');
      },
    } as LastDeps,
  };
}

describe('lastCommand', () => {
  afterEach(() => {
    while (tmpProjects.length > 0) {
      const projectDir = tmpProjects.pop();
      if (projectDir && existsSync(projectDir))
        rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('throws when no sessions directory exists', async () => {
    const projectDir = makeTmpProject();
    const { deps } = captureContinuation();

    await expect(lastCommand({ projectDir } as never, deps)).rejects.toThrow(/no sessions found/);
  });

  it('selects the session with the highest startTimeMs', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeSessionWithLockfile(projectDir, '2025-04-01-older', 1000);
    makeSessionWithLockfile(projectDir, '2025-04-02-newer', 2000);
    makeSessionWithLockfile(projectDir, '2025-04-01-middle', 1500);

    await lastCommand({ projectDir } as never, deps);

    expect(sessionIds).toEqual(['2025-04-02-newer']);
  });

  it('rejects --worktree as a start-only flag before resolving any session', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeSessionWithLockfile(projectDir, '2025-04-01-only', 5000);

    await expect(lastCommand({ projectDir, worktree: 'feature-x' } as never, deps)).rejects.toThrow(
      /--worktree is only supported by `splitbrief start`/,
    );
    expect(sessionIds).toEqual([]);
  });

  it('works with a single session', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeSessionWithLockfile(projectDir, '2025-04-01-only', 5000);

    await lastCommand({ projectDir } as never, deps);

    expect(sessionIds).toEqual(['2025-04-01-only']);
  });

  it('continues a lockfile-less interactive session', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeInteractiveSession(projectDir, '2025-04-03-interactive', 8_000_000);

    await lastCommand({ projectDir } as never, deps);

    expect(sessionIds).toEqual(['2025-04-03-interactive']);
  });

  it('prefers a newer interactive session over an older detached one', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeSessionWithLockfile(projectDir, '2025-04-01-detached', 1_000_000);
    makeInteractiveSession(projectDir, '2025-04-05-interactive', 5_000_000);

    await lastCommand({ projectDir } as never, deps);

    expect(sessionIds).toEqual(['2025-04-05-interactive']);
  });

  it('no longer rejects on Windows, delegating the attach/resume decision to continue', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeSessionWithLockfile(projectDir, '2025-04-01-windows', 5000);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await lastCommand({ projectDir } as never, deps);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }

    expect(sessionIds).toEqual(['2025-04-01-windows']);
  });
});
