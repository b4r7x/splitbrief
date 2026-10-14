import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig } from './defaults.js';
import { configPath } from './document.js';
import { initConfig } from './io.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function checkoutStatus(repoDir: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
}

type IgnoredRepo = Readonly<{ repoDir: string; projectDir: string }>;

const ignoreSources: ReadonlyArray<readonly [string, (repoDir: string) => IgnoredRepo]> = [
  [
    'a .splitbrief/* rule in .git/info/exclude',
    (repoDir) => {
      createTestGitRepo(repoDir, { '.gitignore': 'node_modules/\n' });
      appendFileSync(join(repoDir, '.git', 'info', 'exclude'), '.splitbrief/*\n');
      return { repoDir, projectDir: repoDir };
    },
  ],
  [
    'a .gitignore rule without the trailing slash',
    (repoDir) => {
      createTestGitRepo(repoDir, { '.gitignore': 'node_modules/\n.splitbrief\n' });
      return { repoDir, projectDir: repoDir };
    },
  ],
  [
    'the .gitignore of a parent directory in the repository',
    (repoDir) => {
      createTestGitRepo(repoDir, {
        '.gitignore': 'node_modules/\n.splitbrief/\n',
        'app/.gitignore': 'dist/\n',
      });
      return { repoDir, projectDir: join(repoDir, 'app') };
    },
  ],
];

describe('initConfig in a clean checkout', () => {
  it.each(ignoreSources)(
    'leaves the checkout clean when git already ignores .splitbrief/ through %s',
    async (_source, setup) => {
      const { repoDir, projectDir } = setup(createTempDir('config-init-clean'));
      dirs.push(repoDir);
      const ignorePath = join(projectDir, '.gitignore');
      const before = readFileSync(ignorePath, 'utf8');
      expect(checkoutStatus(repoDir)).toBe('');

      expect(await initConfig(projectDir, createDefaultConfig())).toBe('saved');

      expect(existsSync(configPath(projectDir))).toBe(true);
      expect(readFileSync(ignorePath, 'utf8')).toBe(before);
      expect(checkoutStatus(repoDir)).toBe('');
    },
  );

  it.each(['node_modules/\n', 'node_modules/\n.splitbrief/*/\n'])(
    'adds the .splitbrief/ rule when git still reports the config file under %j',
    async (before) => {
      const repoDir = createTempDir('config-init-unignored');
      dirs.push(repoDir);
      createTestGitRepo(repoDir, { '.gitignore': before });

      expect(await initConfig(repoDir, createDefaultConfig())).toBe('saved');

      expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe(`${before}.splitbrief/\n`);
      expect(checkoutStatus(repoDir)).toBe(' M .gitignore\n');
    },
  );
});
