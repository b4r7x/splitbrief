import { chmodSync, mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { resetLoggerForTests } from '../../../lib/logger.js';
import { sessionDir } from '../../../core/paths.js';
import { acquireLiveness } from './liveness.js';

describe('acquireLiveness', () => {
  afterEach(() => {
    resetLoggerForTests();
  });

  it('names the run lock, the cause and the file when the release cannot be saved', async () => {
    const projectDir = createTempDir('liveness-');
    const sessionId = 'liveness-session';
    const release = await acquireLiveness({ projectDir, sessionId, feature: 'f' });
    enableDebugLog(projectDir);
    const dir = sessionDir(projectDir, sessionId);
    chmodSync(dir, 0o555);
    try {
      await release();
      expect(loggedDiagnostics(projectDir)).toEqual([
        'Could not release the run lock: permission denied · .splitbrief/sessions/liveness-session/lockfile.json · other SPLITBRIEF processes may have to wait for this process to exit',
      ]);
    } finally {
      chmodSync(dir, 0o755);
      cleanupTempDir(projectDir);
    }
  });

  it('refuses to run when its lock cannot be written', async () => {
    const projectDir = createTempDir('liveness-');
    const sessionId = 'liveness-session';
    const dir = sessionDir(projectDir, sessionId);
    mkdirSync(dir, { recursive: true });
    enableDebugLog(projectDir);
    chmodSync(dir, 0o555);
    try {
      await expect(acquireLiveness({ projectDir, sessionId, feature: 'f' })).rejects.toThrow(
        /Could not (hold|write) the run lock/,
      );
    } finally {
      chmodSync(dir, 0o755);
      cleanupTempDir(projectDir);
    }
  });
});
