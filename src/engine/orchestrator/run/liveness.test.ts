import { chmodSync, mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import { acquireLiveness } from './liveness.js';

describe('acquireLiveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the run lock, the cause and the file when the release cannot be saved', async () => {
    const projectDir = createTempDir('liveness-');
    const sessionId = 'liveness-session';
    const release = await acquireLiveness({ projectDir, sessionId, feature: 'f' });
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const dir = sessionDir(projectDir, sessionId);
    chmodSync(dir, 0o555);
    try {
      await release();
    } finally {
      chmodSync(dir, 0o755);
      cleanupTempDir(projectDir);
    }

    expect(writes).toEqual([
      'Could not release the run lock: permission denied · .splitbrief/sessions/liveness-session/lockfile.json · other SPLITBRIEF processes can see the run as running for a few more seconds\n',
    ]);
  });

  it('reports a lock it could not write once: its release writes nothing more', async () => {
    const projectDir = createTempDir('liveness-');
    const sessionId = 'liveness-session';
    const dir = sessionDir(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    chmodSync(dir, 0o555);
    try {
      const release = await acquireLiveness({ projectDir, sessionId, feature: 'f' });
      await release();
    } finally {
      chmodSync(dir, 0o755);
      cleanupTempDir(projectDir);
    }

    expect(writes).toEqual([
      'Could not write the run lock: permission denied · .splitbrief/sessions/liveness-session/lockfile.json · another SPLITBRIEF process can open this run at the same time\n',
    ]);
  });
});
