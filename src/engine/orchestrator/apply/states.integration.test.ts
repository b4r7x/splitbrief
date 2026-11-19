import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { readHeadSha } from '../../../lib/git/repository.js';
import { createSnapshot } from '../../snapshots/create.js';
import { createRunIsolation } from '../isolation/create.js';
import { captureReviewedCandidate } from './states.js';

describe('capturing a pinned staged candidate', () => {
  it('includes new workspace files even if the original checkout starts ignoring their names', async () => {
    await withTempDir('pinned-staged-candidate-', async (projectDir) => {
      createTestGitRepo(projectDir, { '.gitignore': '.splitbrief/\n', 'input.txt': 'base\n' });
      const ref = { projectDir, sessionId: 'pinned-candidate' };
      const isolation = createRunIsolation({
        ...ref,
        strategy: 'staged-copy',
        onFallback: () => {},
      });
      try {
        const head = await readHeadSha(projectDir);
        const workspace = await isolation.open({ config: makeConfig() });
        const { manifest } = await createSnapshot({ ...ref, phase: 'manual' });
        writeFileSync(join(projectDir, '.gitignore'), '.splitbrief/\nnew.txt\n');
        writeFileSync(join(workspace.projectDir, 'new.txt'), 'new in the workspace\n');

        expect(
          await captureReviewedCandidate({
            ...ref,
            workspace: {
              kind: 'staged-copy',
              path: workspace.projectDir,
              base: { snapshotId: manifest.id, head },
            },
          }),
        ).toHaveProperty('new.txt', expect.stringMatching(/^file:/));
      } finally {
        await isolation.dispose();
      }
    });
  });
});
