import { chmodSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import { acquireLiveness } from './liveness.js';

describe('acquireLiveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the cause before the lockfile when the run cannot be marked as ended', async () => {
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
      'Could not mark the run as ended: permission denied · .splitbrief/sessions/liveness-session/lockfile.json\n',
    ]);
  });
});
