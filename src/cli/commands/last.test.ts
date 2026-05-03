import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lastCommand } from './last.js';
import type { LastDeps } from './last.js';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `diptych-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
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

const mockContinueCommand = vi.fn().mockResolvedValue(undefined);
const fakeDeps: LastDeps = { continueCommand: mockContinueCommand };

describe('lastCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when no sessions directory exists', async () => {
    const projectDir = makeTmpProject();

    await expect(
      lastCommand({ projectDir } as never, fakeDeps),
    ).rejects.toThrow(/no sessions found/);
  });

  it('throws when sessions directory is empty', async () => {
    const projectDir = makeTmpProject();
    mkdirSync(join(projectDir, '.diptych', 'sessions'), { recursive: true });

    await expect(
      lastCommand({ projectDir } as never, fakeDeps),
    ).rejects.toThrow(/no sessions found/);
  });

  it('throws when no session has a valid lockfile', async () => {
    const projectDir = makeTmpProject();
    // Create a session dir with no lockfile.
    mkdirSync(join(projectDir, '.diptych', 'sessions', 'orphan-session'), { recursive: true });

    await expect(
      lastCommand({ projectDir } as never, fakeDeps),
    ).rejects.toThrow(/no sessions found/);
  });

  it('selects the session with the highest startTimeMs', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, '2025-04-01-older', 1000);
    makeSessionWithLockfile(projectDir, '2025-04-02-newer', 2000);
    makeSessionWithLockfile(projectDir, '2025-04-01-middle', 1500);

    await lastCommand({ projectDir } as never, fakeDeps);

    expect(mockContinueCommand).toHaveBeenCalledWith(
      '2025-04-02-newer',
      expect.objectContaining({ projectDir }),
    );
  });

  it('works with a single session', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, '2025-04-01-only', 5000);

    await lastCommand({ projectDir } as never, fakeDeps);

    expect(mockContinueCommand).toHaveBeenCalledWith(
      '2025-04-01-only',
      expect.objectContaining({ projectDir }),
    );
  });
});
