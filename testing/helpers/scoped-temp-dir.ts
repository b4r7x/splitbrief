import { afterEach } from 'vitest';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

export function setupScopedTempDir(prefix: string): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });
  return () => {
    const dir = createTempDir(prefix);
    dirs.push(dir);
    return dir;
  };
}
