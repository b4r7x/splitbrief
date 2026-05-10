import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lastCommand } from './last.js';
import type { LastDeps } from './last.js';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `diptych-test-${randomUUID()}`);
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
  const sessDir = join(projectDir, '.diptych', 'sessions', sessionId);
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
      if (projectDir && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'no sessions directory exists',
      arrange: (_projectDir: string) => {},
    },
    {
      name: 'sessions directory is empty',
      arrange: (projectDir: string) => {
        mkdirSync(join(projectDir, '.diptych', 'sessions'), { recursive: true });
      },
    },
    {
      name: 'no session has a valid lockfile',
      arrange: (projectDir: string) => {
        mkdirSync(join(projectDir, '.diptych', 'sessions', 'orphan-session'), { recursive: true });
      },
    },
  ])('throws when $name', async ({ arrange }) => {
    const projectDir = makeTmpProject();
    arrange(projectDir);
    const { deps } = captureContinuation();

    await expect(
      lastCommand({ projectDir } as never, deps),
    ).rejects.toThrow(/no sessions found/);
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

  it('works with a single session', async () => {
    const projectDir = makeTmpProject();
    const { deps, sessionIds } = captureContinuation();

    makeSessionWithLockfile(projectDir, '2025-04-01-only', 5000);

    await lastCommand({ projectDir } as never, deps);

    expect(sessionIds).toEqual(['2025-04-01-only']);
  });
});
