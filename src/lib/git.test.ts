import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isGitRepo,
  hasCommits,
  getCurrentDiff,
  getDiffSince,
  getRunStartHead,
  getCurrentChangedFiles,
  getInProgressGitOp,
  discardFileChange,
  discardChangedFiles,
  branchExists,
  createBranch,
  createTaggedStash,
  checkIgnoredPaths,
  getStagedFiles,
  getCommittedFilesSince,
  listTrackedAndUntrackedFiles,
  listGitlinkPaths,
  discardSubmoduleChange,
  gitError,
} from './git.js';
import { execSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, startConflictingMerge } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('diptych-git-test');
  createTestGitRepo(dir);
  return dir;
}

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    cleanupTempDir(d);
  }
  dirs = [];
});

function tracked(dir: string) {
  dirs.push(dir);
  return dir;
}

describe('git utils', () => {
  describe('isGitRepo', () => {
    it('returns true inside a git repo', async () => {
      const dir = tracked(setupGitRepo());
      expect(await isGitRepo(dir)).toBe(true);
    });

    it('returns false outside a git repo', async () => {
      const dir = tracked(createTempDir('diptych-nogit'));
      expect(await isGitRepo(dir)).toBe(false);
    });
  });

  describe('hasCommits', () => {
    it('returns true for a repo with at least one commit', async () => {
      const dir = tracked(setupGitRepo());
      expect(await hasCommits(dir)).toBe(true);
    });

    it('returns false for a freshly initialized repo with no commits', async () => {
      const dir = tracked(createTempDir('diptych-unborn'));
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      expect(await hasCommits(dir)).toBe(false);
    });
  });

  describe('getCurrentDiff', () => {
    it('returns combined staged and unstaged diff', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'changed');
      const diff = await getCurrentDiff(dir);
      expect(diff).toContain('changed');
    });

    it('returns empty string when no changes', async () => {
      const dir = tracked(setupGitRepo());
      const diff = await getCurrentDiff(dir);
      expect(diff).toBe('');
    });

    it('returns plain text even when the repo forces color.diff=always', async () => {
      const dir = tracked(setupGitRepo());
      execSync('git config color.diff always', { cwd: dir, stdio: 'pipe' });
      writeFileSync(join(dir, 'init.txt'), 'changed');
      writeFileSync(join(dir, 'untracked.txt'), 'BRANDNEW');
      const diff = await getCurrentDiff(dir);
      const esc = String.fromCharCode(27);
      expect(diff).not.toContain(esc);
      expect(diff).toContain('changed');
      expect(diff).toContain('BRANDNEW');
    });
  });

  describe('getRunStartHead', () => {
    it('returns the newest commit whose subject does not start with the run prefix', async () => {
      const dir = tracked(setupGitRepo());
      const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      writeFileSync(join(dir, 'a.txt'), 'a');
      execSync('git add a.txt && git commit -m "feat(diptych): T001 - a"', {
        cwd: dir,
        stdio: 'pipe',
      });
      writeFileSync(join(dir, 'b.txt'), 'b');
      execSync('git add b.txt && git commit -m "feat(diptych): T002 - b"', {
        cwd: dir,
        stdio: 'pipe',
      });
      expect(await getRunStartHead(dir, 'feat(diptych):')).toBe(base);
    });

    it('returns null when every reachable commit carries the run prefix', async () => {
      const dir = tracked(createTempDir('diptych-allrun'));
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email "t@t.com" && git config user.name "T"', {
        cwd: dir,
        stdio: 'pipe',
      });
      writeFileSync(join(dir, 'a.txt'), 'a');
      execSync('git add a.txt && git commit -m "feat(diptych): T001 - a"', {
        cwd: dir,
        stdio: 'pipe',
      });
      expect(await getRunStartHead(dir, 'feat(diptych):')).toBeNull();
    });
  });

  describe('getDiffSince', () => {
    it('includes both committed-since-base changes and untracked working-tree files', async () => {
      const dir = tracked(setupGitRepo());
      const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      writeFileSync(join(dir, 'committed.txt'), 'COMMITTED_BODY');
      execSync('git add committed.txt && git commit -m "feat(diptych): T001"', {
        cwd: dir,
        stdio: 'pipe',
      });
      writeFileSync(join(dir, 'untracked.txt'), 'UNTRACKED_BODY');

      const diff = await getDiffSince(dir, base);
      expect(diff).toContain('COMMITTED_BODY');
      expect(diff).toContain('UNTRACKED_BODY');
    });
  });

  describe('getCurrentChangedFiles', () => {
    it('returns modified file paths', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      const files = await getCurrentChangedFiles(dir);
      expect(files).toContain('init.txt');
    });

    it('returns empty array for clean working tree', async () => {
      const dir = tracked(setupGitRepo());
      const files = await getCurrentChangedFiles(dir);
      expect(files).toEqual([]);
    });

    it('includes new untracked files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'new-file.txt'), 'content');
      const files = await getCurrentChangedFiles(dir);
      expect(files).toContain('new-file.txt');
    });
  });

  describe('branchExists', () => {
    it('returns false for a branch that does not exist', async () => {
      const dir = tracked(setupGitRepo());
      expect(await branchExists(dir, 'diptych/nonexistent')).toBe(false);
    });

    it('returns true for the current branch', async () => {
      const dir = tracked(setupGitRepo());
      const g = simpleGit(dir);
      const status = await g.status();
      const currentBranch = status.current ?? 'main';
      expect(await branchExists(dir, currentBranch)).toBe(true);
    });
  });

  describe('createBranch', () => {
    it('creates a new branch and returns its name', async () => {
      const dir = tracked(setupGitRepo());
      const name = await createBranch(dir, 'diptych/add-auth');
      expect(name).toBe('diptych/add-auth');
      const g = simpleGit(dir);
      const status = await g.status();
      expect(status.current).toBe('diptych/add-auth');
    });

    it('appends -2 on collision', async () => {
      const dir = tracked(setupGitRepo());
      const g = simpleGit(dir);
      const initStatus = await g.status();
      const defaultBranch = initStatus.current ?? 'main';
      await createBranch(dir, 'diptych/foo');
      await g.checkout(defaultBranch);
      const name = await createBranch(dir, 'diptych/foo');
      expect(name).toBe('diptych/foo-2');
    });

    it('increments suffix through multiple collisions', async () => {
      const dir = tracked(setupGitRepo());
      const g = simpleGit(dir);
      const initStatus = await g.status();
      const defaultBranch = initStatus.current ?? 'main';
      await createBranch(dir, 'diptych/bar');
      await g.checkout(defaultBranch);
      await g.checkoutLocalBranch('diptych/bar-2');
      await g.checkout(defaultBranch);
      const name = await createBranch(dir, 'diptych/bar');
      expect(name).toBe('diptych/bar-3');
    });
  });

  describe('discardFileChange', () => {
    it('checks out a tracked file', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      await discardFileChange(dir, 'init.txt', 'tracked');
      const content = readFileSync(join(dir, 'init.txt'), 'utf-8');
      expect(content).toBe('init');
    });

    it('cleans an untracked file', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'created.txt'), 'new file');
      await discardFileChange(dir, 'created.txt', 'untracked');
      expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    });
  });

  describe('discardChangedFiles', () => {
    it('discards both tracked and untracked files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      writeFileSync(join(dir, 'created.txt'), 'new file');

      await discardChangedFiles(dir, ['init.txt', 'created.txt']);

      expect(readFileSync(join(dir, 'init.txt'), 'utf-8')).toBe('init');
      expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    });

    it('removes an untracked embedded git repository on a directory pathspec', async () => {
      const dir = tracked(setupGitRepo());
      const embedded = join(dir, 'vendored');
      mkdirSync(embedded, { recursive: true });
      execSync('git init', { cwd: embedded, stdio: 'pipe' });
      execSync('git config user.email "t@t.com" && git config user.name "T"', {
        cwd: embedded,
        stdio: 'pipe',
      });
      writeFileSync(join(embedded, 'inner.txt'), 'inner');
      execSync('git add inner.txt && git commit -m inner', { cwd: embedded, stdio: 'pipe' });

      await discardChangedFiles(dir, ['vendored/']);

      expect(existsSync(embedded)).toBe(false);
    });
  });

  describe('submodule gitlinks', () => {
    function setupSuperproject(): string {
      const root = tracked(createTempDir('diptych-git-submodule'));
      const sub = join(root, 'subrepo');
      mkdirSync(sub, { recursive: true });
      execSync('git init -q', { cwd: sub, stdio: 'pipe' });
      execSync('git config user.email "t@t.com" && git config user.name "T"', {
        cwd: sub,
        stdio: 'pipe',
      });
      writeFileSync(join(sub, 'file.txt'), 'v1\n');
      execSync('git add file.txt && git commit -qm v1', { cwd: sub, stdio: 'pipe' });

      const project = join(root, 'superproject');
      mkdirSync(project, { recursive: true });
      execSync('git init -q', { cwd: project, stdio: 'pipe' });
      execSync('git config user.email "t@t.com" && git config user.name "T"', {
        cwd: project,
        stdio: 'pipe',
      });
      writeFileSync(join(project, 'top.txt'), 'top\n');
      execSync('git add top.txt && git commit -qm top', { cwd: project, stdio: 'pipe' });
      execSync(`git -c protocol.file.allow=always submodule add -q "${sub}" sub`, {
        cwd: project,
        stdio: 'pipe',
      });
      execSync('git commit -qm "add sub"', { cwd: project, stdio: 'pipe' });
      return project;
    }

    it('lists tracked gitlink paths and excludes regular files', async () => {
      const project = setupSuperproject();
      const gitlinks = await listGitlinkPaths(project);
      expect(gitlinks).toEqual(['sub']);
    });

    it('returns an empty list for a repository without submodules', async () => {
      const dir = tracked(setupGitRepo());
      expect(await listGitlinkPaths(dir)).toEqual([]);
    });

    it('resets a moved submodule back to its recorded commit', async () => {
      const project = setupSuperproject();
      writeFileSync(join(project, 'sub', 'file.txt'), 'v2\n');
      execSync('git add file.txt && git commit -qm v2', {
        cwd: join(project, 'sub'),
        stdio: 'pipe',
      });
      expect(await getCurrentChangedFiles(project)).toContain('sub');

      await discardSubmoduleChange(project, 'sub');

      expect(readFileSync(join(project, 'sub', 'file.txt'), 'utf-8')).toBe('v1\n');
      expect(await getCurrentChangedFiles(project)).not.toContain('sub');
    });
  });

  describe('runGit error wrapping', () => {
    it('wraps a failed simple-git call as a typed GitCommandError', async () => {
      const dir = tracked(createTempDir('diptych-nogit-diff'));
      await expect(getCurrentDiff(dir)).rejects.toMatchObject({ kind: 'git-command-failed' });
    });
  });

  describe('checkIgnoredPaths', () => {
    it('returns empty array for empty input', async () => {
      const dir = tracked(setupGitRepo());
      const result = await checkIgnoredPaths(dir, []);
      expect(result).toEqual([]);
    });

    it('identifies gitignored paths via stdin', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, '.gitignore'), '*.log\ndist/\n');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'debug.log'), 'x');
      writeFileSync(join(dir, 'dist', 'bundle.js'), 'x');
      writeFileSync(join(dir, 'src.ts'), 'export {}');

      const result = await checkIgnoredPaths(dir, ['debug.log', 'dist/bundle.js', 'src.ts']);
      expect(result).toContain('debug.log');
      expect(result).toContain('dist/bundle.js');
      expect(result).not.toContain('src.ts');
    });

    it('handles paths with spaces', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, '.gitignore'), '*.log\n');
      writeFileSync(join(dir, 'my file.log'), 'x');

      const result = await checkIgnoredPaths(dir, ['my file.log']);
      expect(result).toContain('my file.log');
    });
  });

  describe('getStagedFiles', () => {
    it('returns the staged path verbatim for a non-ASCII filename', async () => {
      const dir = tracked(setupGitRepo());
      const git = simpleGit(dir);
      writeFileSync(join(dir, 'café.ts'), 'export {}');
      await git.add(['--', 'café.ts']);

      const staged = await getStagedFiles(dir);
      expect(staged).toContain('café.ts');
    });
  });

  describe('getCommittedFilesSince', () => {
    it('returns the committed path verbatim for a non-ASCII filename', async () => {
      const dir = tracked(setupGitRepo());
      const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      writeFileSync(join(dir, 'résumé.md'), 'body');
      execSync('git add "résumé.md" && git commit -m "feat(diptych): T001"', {
        cwd: dir,
        stdio: 'pipe',
      });

      const committed = await getCommittedFilesSince(dir, base);
      expect(committed).toContain('résumé.md');
    });
  });

  describe('listTrackedAndUntrackedFiles', () => {
    it('lists tracked and untracked files and omits gitignored ones', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
      writeFileSync(join(dir, 'ignored.txt'), 'x');
      writeFileSync(join(dir, 'tracked.ts'), 'export {}');
      execSync('git add tracked.ts && git commit -m "feat(diptych): T001"', {
        cwd: dir,
        stdio: 'pipe',
      });
      writeFileSync(join(dir, 'untracked.ts'), 'export {}');

      const files = await listTrackedAndUntrackedFiles(dir);
      expect(files).toContain('tracked.ts');
      expect(files).toContain('untracked.ts');
      expect(files).not.toContain('ignored.txt');
    });

    it('returns a non-ASCII filename verbatim', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'naïve.ts'), 'export {}');

      const files = await listTrackedAndUntrackedFiles(dir);
      expect(files).toContain('naïve.ts');
    });

    it('returns null outside a git repository', async () => {
      const dir = tracked(createTempDir('diptych-nogit-ls'));
      expect(await listTrackedAndUntrackedFiles(dir)).toBeNull();
    });
  });

  describe('createTaggedStash', () => {
    it('preserves the staged/unstaged split across a successful checkpoint', async () => {
      const dir = tracked(setupGitRepo());
      const git = simpleGit(dir);
      // User pre-stages one file and leaves another only in the working tree.
      writeFileSync(join(dir, 'staged.txt'), 'staged by user');
      writeFileSync(join(dir, 'unstaged.txt'), 'left in working tree');
      await git.add(['--', 'staged.txt']);

      const tag = await createTaggedStash(dir, 'diptych checkpoint: T001', 'diptych/T001');
      expect(tag).toBe('diptych/T001');

      // The checkpoint tag captured the full working-tree state.
      const tags = await git.tags();
      expect(tags.all).toContain('diptych/T001');
      // The original split is intact: only staged.txt is in the index.
      const stagedAfter = (await git.diff(['--cached', '--name-only'])).trim();
      expect(stagedAfter).toBe('staged.txt');
      // Both files still exist in the working tree.
      expect(existsSync(join(dir, 'staged.txt'))).toBe(true);
      expect(existsSync(join(dir, 'unstaged.txt'))).toBe(true);
    });

    it('restores the clean pre-stage index when tag creation fails', async () => {
      const dir = tracked(setupGitRepo());
      const git = simpleGit(dir);
      writeFileSync(join(dir, 'seed.txt'), 'seed');
      await git.add('seed.txt');
      const seedSha = (await git.raw(['stash', 'create', 'seed stash'])).trim();
      await git.tag(['diptych/T001', seedSha]);
      await git.reset(['--mixed', 'HEAD']);

      writeFileSync(join(dir, 'staged.txt'), 'new content');

      await expect(
        createTaggedStash(dir, 'diptych checkpoint: T001', 'diptych/T001'),
      ).rejects.toMatchObject({ kind: 'git-command-failed' });

      const stagedAfter = (await git.diff(['--cached', '--name-only'])).trim();
      expect(stagedAfter).toBe('');
    });
  });

  describe('getInProgressGitOp', () => {
    it('returns null for a clean repository', async () => {
      const dir = tracked(setupGitRepo());
      expect(await getInProgressGitOp(dir)).toBeNull();
    });

    it('detects a conflicted merge in progress', async () => {
      const dir = tracked(createTempDir('diptych-merge'));
      startConflictingMerge(dir);
      expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
      expect(await getInProgressGitOp(dir)).toBe('merge');
    });

    it('detects a rebase in progress', async () => {
      const dir = tracked(setupGitRepo());
      mkdirSync(join(dir, '.git', 'rebase-merge'), { recursive: true });
      expect(await getInProgressGitOp(dir)).toBe('rebase');
    });

    it('detects a cherry-pick in progress', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, '.git', 'CHERRY_PICK_HEAD'), 'deadbeef\n');
      expect(await getInProgressGitOp(dir)).toBe('cherry-pick');
    });

    it('returns null outside a git repository', async () => {
      const dir = tracked(createTempDir('diptych-nogit-op'));
      expect(await getInProgressGitOp(dir)).toBeNull();
    });
  });

  describe('gitError', () => {
    it('creates a discriminated AppError for failed commands', () => {
      const err = gitError.commandFailed('rev-parse HEAD', 'not a git repository');
      expect(err).toBeInstanceOf(Error);
      expect(err.kind).toBe('git-command-failed');
      expect(err.message).toContain('rev-parse HEAD');
      expect(err.message).toContain('not a git repository');
      expect(err.data).toEqual({ intent: 'rev-parse HEAD', causeMessage: 'not a git repository' });
    });
  });
});
