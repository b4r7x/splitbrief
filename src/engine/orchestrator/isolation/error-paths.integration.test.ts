import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createRunIsolation } from './create.js';
import { setProjectRoot, toErrorMessage } from '../../../utils/format-errors.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('run workspace error paths', () => {
  it.each(['staged-copy', 'worktree'] as const)(
    'reads workspace error paths relative to workspace while open and not after dispose: %s',
    async (strategy) => {
      const projectDir = createTempDir(`error-paths-${strategy}`);
      dirs.push(projectDir);
      createTestGitRepo(projectDir, { 'source.txt': 'checkout\n' });
      setProjectRoot(projectDir);

      const isolation = createRunIsolation({
        projectDir,
        sessionId: `error-paths-${strategy}`,
        strategy,
        onFallback: vi.fn(),
      });
      try {
        const opened = await isolation.open({ config: makeConfig() });
        expect(opened.kind).toBe(strategy);

        const target = join(opened.projectDir, 'src', 'a.ts');
        const err = Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
          code: 'EACCES',
          path: target,
        });

        expect(toErrorMessage(err)).toBe(`permission denied · ${join('src', 'a.ts')}`);

        await isolation.dispose();

        expect(toErrorMessage(err)).not.toBe(`permission denied · ${join('src', 'a.ts')}`);
      } finally {
        await isolation.dispose();
      }
    },
  );
});
