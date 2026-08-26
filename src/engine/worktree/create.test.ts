import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { initConfig } from '../../core/config/load/io.js';
import { createWorktree } from './create.js';
import { SPLITBRIEF_DIR, CONFIG_FILE, TREES_DIR } from '../../core/paths.js';

let repoDir: string;
let git: SimpleGit;

async function initRepo(dir: string): Promise<SimpleGit> {
  createTestGitRepo(dir, { 'README.md': '# test\n' });
  return simpleGit(dir);
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'worktree-create-test-'));
  git = await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('createWorktree', () => {
  it('creates a worktree directory with a .git file and splitbrief branch', async () => {
    const slug = 'feat-a';
    await createWorktree({ projectDir: repoDir, slug, git });
    const wtPath = join(repoDir, TREES_DIR, slug);
    expect(existsSync(wtPath)).toBe(true);
    const gitMarker = join(wtPath, '.git');
    expect(existsSync(gitMarker)).toBe(true);
    expect(statSync(gitMarker).isFile()).toBe(true);
    const branches = await git.branch();
    expect(branches.all).toContain(`splitbrief/${slug}`);
  });

  it('throws when the branch splitbrief/<slug> already exists', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-c', git });
    await expect(createWorktree({ projectDir: repoDir, slug: 'feat-c', git })).rejects.toThrow(
      'Branch splitbrief/feat-c already exists',
    );
  });

  it('hands a git-valid prune remediation when retry-create hits the stale branch (F-392)', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-stale', git });
    rmSync(join(repoDir, TREES_DIR, 'feat-stale'), { recursive: true, force: true });
    expect((await git.branch()).all).toContain('splitbrief/feat-stale');

    await expect(createWorktree({ projectDir: repoDir, slug: 'feat-stale', git })).rejects.toThrow(
      'git worktree prune" then "git branch -D splitbrief/feat-stale',
    );
  });

  it('refuses to create a worktree when the source working tree is dirty', async () => {
    await writeFile(join(repoDir, 'dirty.txt'), 'uncommitted');

    await expect(createWorktree({ projectDir: repoDir, slug: 'feat-dirty', git })).rejects.toThrow(
      'Source working tree is dirty (1 uncommitted file(s): dirty.txt)',
    );

    expect(existsSync(join(repoDir, TREES_DIR, 'feat-dirty'))).toBe(false);
  });

  it('creates the worktree from a dirty source when requireCleanSource is false', async () => {
    await writeFile(join(repoDir, 'dirty.txt'), 'uncommitted');

    const wtPath = await createWorktree({
      projectDir: repoDir,
      slug: 'feat-dirty-optout',
      git,
      requireCleanSource: false,
    });

    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, 'dirty.txt'))).toBe(false);
  });

  it('does not count files inside .trees/ as dirty when creating another worktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-pre', git });
    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-second', git }),
    ).resolves.toBeDefined();
    expect(existsSync(join(repoDir, TREES_DIR, 'feat-second'))).toBe(true);
  });

  it('succeeds on a committed repo whose only dirt is initConfig .gitignore bookkeeping', async () => {
    await initConfig(repoDir);

    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-bookkeeping', git }),
    ).resolves.toBeDefined();
    expect(existsSync(join(repoDir, TREES_DIR, 'feat-bookkeeping'))).toBe(true);
  });

  it('still names a user-edited .gitignore beyond the bookkeeping lines as dirty', async () => {
    await initConfig(repoDir);
    await writeFile(join(repoDir, '.gitignore'), '.splitbrief/\n.trees/\nnode_modules/\n');

    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-user-edit', git }),
    ).rejects.toThrow('uncommitted file(s): .gitignore');
    expect(existsSync(join(repoDir, TREES_DIR, 'feat-user-edit'))).toBe(false);
  });

  it('rejects path traversal via git and leaves no branch or worktree path', async () => {
    const slug = '../escape';
    await expect(createWorktree({ projectDir: repoDir, slug, git })).rejects.toThrow();
    const branches = await git.branch();
    expect(branches.all).not.toContain(`splitbrief/${slug}`);
    expect(existsSync(join(repoDir, TREES_DIR, slug))).toBe(false);
  });

  it('accepts a valid worktree name', async () => {
    const slug = 'feat-x';
    await expect(createWorktree({ projectDir: repoDir, slug, git })).resolves.toBeDefined();
    expect(existsSync(join(repoDir, TREES_DIR, slug))).toBe(true);
  });

  it('carries the base .splitbrief/config.yaml into the new worktree', async () => {
    const ignoredRepo = await mkdtemp(join(tmpdir(), 'worktree-config-'));
    try {
      createTestGitRepo(ignoredRepo, {
        'README.md': '# test\n',
        '.gitignore': '.splitbrief/\n.trees/\n',
      });
      const ignoredGit = simpleGit(ignoredRepo);
      const configBody = 'version: 3\nimplementer:\n  kind: api\n  provider: ollama\n';
      await mkdir(join(ignoredRepo, SPLITBRIEF_DIR), { recursive: true });
      await writeFile(join(ignoredRepo, SPLITBRIEF_DIR, CONFIG_FILE), configBody);

      const wtPath = await createWorktree({
        projectDir: ignoredRepo,
        slug: 'feat-cfg',
        git: ignoredGit,
      });

      const propagated = await readFile(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE), 'utf-8');
      expect(propagated).toBe(configBody);
    } finally {
      await rm(ignoredRepo, { recursive: true, force: true });
    }
  });

  it('gitignores .splitbrief/ in the new worktree so a copied config secret stays untracked', async () => {
    await initConfig(repoDir);

    const wtPath = await createWorktree({ projectDir: repoDir, slug: 'feat-ignore', git });

    const ignoreLines = (await readFile(join(wtPath, '.gitignore'), 'utf-8'))
      .split('\n')
      .map((line) => line.trim());
    expect(ignoreLines).toContain(`${SPLITBRIEF_DIR}/`);
    expect(ignoreLines).toContain(`${TREES_DIR}/`);
    expect(existsSync(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);
  });

  it('populates submodules in the new worktree instead of leaving empty dirs (F-405)', async () => {
    const superRepo = await mkdtemp(join(tmpdir(), 'worktree-super-'));
    const subRepo = await mkdtemp(join(tmpdir(), 'worktree-sub-'));
    const prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file';
    try {
      const runGit = (cwd: string, args: string[]): void => {
        execFileSync('git', args, { cwd, stdio: 'pipe' });
      };

      createTestGitRepo(subRepo, { 'lib.txt': 'submodule content\n' });
      createTestGitRepo(superRepo, { 'README.md': '# super\n' });

      runGit(superRepo, ['submodule', 'add', subRepo, 'vendor']);
      runGit(superRepo, ['commit', '-m', 'add submodule']);

      const superGit = simpleGit(superRepo);
      const wtPath = await createWorktree({
        projectDir: superRepo,
        slug: 'feat-sub',
        git: superGit,
      });

      const submoduleFile = join(wtPath, 'vendor', 'lib.txt');
      expect(existsSync(submoduleFile)).toBe(true);
      expect(await readFile(submoduleFile, 'utf-8')).toBe('submodule content\n');
    } finally {
      if (prevAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = prevAllowProtocol;
      await rm(superRepo, { recursive: true, force: true });
      await rm(subRepo, { recursive: true, force: true });
    }
  });
});
