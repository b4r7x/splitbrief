import { ensureSessionDir } from '../../src/core/paths-io.js';
import { createTestGitRepo } from './git.js';
import { createTempDir } from './temp-dir.js';

export interface GitSessionProjectOptions {
  prefix: string;
  sessionId: string;
  files?: Record<string, string> | undefined;
}

export function setupGitSessionProject(opts: GitSessionProjectOptions): {
  projectDir: string;
  sessionId: string;
} {
  const projectDir = createTempDir(opts.prefix);
  createTestGitRepo(projectDir, opts.files ?? {});
  ensureSessionDir(projectDir, opts.sessionId);
  return { projectDir, sessionId: opts.sessionId };
}
