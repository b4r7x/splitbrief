import { afterEach } from 'vitest';
import { ensureSessionDir } from '../../src/core/sessions/spec-files.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export function setupSeatWaitProject(): () => { projectDir: string; sessionId: string } {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  return () => {
    const projectDir = createTempDir('seat-wait-test');
    dirs.push(projectDir);
    const sessionId = 'sess-seat-wait';
    ensureSessionDir(projectDir, sessionId);
    return { projectDir, sessionId };
  };
}
