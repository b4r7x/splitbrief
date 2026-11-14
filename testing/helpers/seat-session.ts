import { afterEach } from 'vitest';
import { ensureSessionDir } from '../../src/core/sessions/spec-files.js';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export function setupSeatSession(): (name: string) => { projectDir: string; sessionId: string } {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  return (name: string) => {
    const projectDir = createTempDir(name);
    dirs.push(projectDir);
    const sessionId = `sess-${name}`;
    ensureSessionDir(projectDir, sessionId);
    return { projectDir, sessionId };
  };
}
