import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureGitignore } from '../lib/fs.js';
import { gitignoreDiffersOnlyBySplitbriefBookkeeping } from './gitignore-bookkeeping.js';
import { SPLITBRIEF_DIR, TREES_DIR } from './paths.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function repoWithGitignore(gitignore: string): string {
  const projectDir = createTempDir('gitignore-bookkeeping');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { '.gitignore': gitignore });
  return projectDir;
}

describe('gitignoreDiffersOnlyBySplitbriefBookkeeping', () => {
  it.each([
    { name: 'a final newline', gitignore: 'node_modules\ndist\n' },
    { name: 'no final newline', gitignore: 'node_modules\ndist' },
    { name: 'CRLF lines and a final newline', gitignore: 'node_modules\r\ndist\r\n' },
    { name: 'CRLF lines and no final newline', gitignore: 'node_modules\r\ndist' },
  ])("treats Setup's lines as bookkeeping in a .gitignore with $name", async ({ gitignore }) => {
    const projectDir = repoWithGitignore(gitignore);
    ensureGitignore(projectDir, `${SPLITBRIEF_DIR}/`);
    ensureGitignore(projectDir, `${TREES_DIR}/`);

    await expect(gitignoreDiffersOnlyBySplitbriefBookkeeping(projectDir)).resolves.toBe(true);
  });

  it('counts an operator line as a change in a .gitignore with no final newline', async () => {
    const projectDir = repoWithGitignore('node_modules\ndist');
    ensureGitignore(projectDir, `${SPLITBRIEF_DIR}/`);
    appendFileSync(join(projectDir, '.gitignore'), 'coverage\n');

    await expect(gitignoreDiffersOnlyBySplitbriefBookkeeping(projectDir)).resolves.toBe(false);
  });
});
