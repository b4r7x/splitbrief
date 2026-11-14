import { ensureSessionDir } from '../../src/core/sessions/spec-files.js';
import { createTempDir } from './temp-dir.js';

export const dirs: string[] = [];

export function setupProjectDir(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('continuation-test');
  dirs.push(projectDir);
  const sessionId = 'sess-continue';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}
