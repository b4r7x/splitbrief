import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  getCurrentChangedFiles,
  listTrackedAndUntrackedFiles,
  listGitlinkPaths,
  discardSubmoduleChange,
  discardFileChange,
  discardChangedFiles,
  checkIgnoredPaths,
} from './files.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

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
