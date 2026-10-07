import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { getCurrentDiff } from './diff.js';
import { checkIgnoredPaths } from './files.js';
import { createGitClient, gitBinary, gitError } from './client.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const originalPath = process.env.PATH;
let dirs: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const d of dirs) {
    cleanupTempDir(d);
  }
  dirs = [];
});

function tracked(dir: string) {
  dirs.push(dir);
  return dir;
}

// The git a bare `git` launch finds on the PATH this file started with.
function pathGit(): string {
  return execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
}

// A `git` that marks its directory with `used`, then runs the real git.
function gitShim(dir: string, realGit: string): string {
  const shim = join(dir, 'git');
  writeFileSync(shim, `#!/bin/sh\n: > "\${0%/*}/used"\nexec '${realGit}' "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

describe('runGit error wrapping', () => {
  it('wraps a failed simple-git call as a typed GitCommandError', async () => {
    const dir = tracked(createTempDir('splitbrief-nogit-diff'));
    await expect(getCurrentDiff(dir, [])).rejects.toMatchObject({ kind: 'git-command-failed' });
  });
});

describe('gitBinary', () => {
  itUnix('is the absolute path of the git that PATH finds first', () => {
    const binary = gitBinary();

    expect(isAbsolute(binary)).toBe(true);
    expect(binary).toBe(pathGit());
  });

  itUnix('follows a PATH change to the git the new PATH finds first', () => {
    const shimDir = tracked(createTempDir('splitbrief-git-shim'));
    const shim = gitShim(shimDir, pathGit());
    process.env.PATH = [shimDir, originalPath].join(delimiter);

    expect(gitBinary()).toBe(shim);
  });

  itUnix(
    'keeps the bare name when no PATH entry holds git, so the launch fails as before',
    async () => {
      const repo = tracked(createTempDir('splitbrief-git-missing'));
      process.env.PATH = tracked(createTempDir('splitbrief-empty-path'));

      expect(gitBinary()).toBe('git');
      await expect(getCurrentDiff(repo, [])).rejects.toMatchObject({
        kind: 'git-command-failed',
        data: { causeMessage: expect.stringContaining('spawn git ENOENT') },
      });
    },
  );
});

describe('createGitClient', () => {
  itUnix('hands simple-git the absolute git binary', async () => {
    const realGit = pathGit();
    const shimDir = tracked(createTempDir('splitbrief-git-client-shim'));
    gitShim(shimDir, realGit);
    const dir = tracked(createTempDir('splitbrief-git-client'));
    process.env.PATH = [shimDir, originalPath].join(delimiter);

    const client = createGitClient(dir);
    process.env.PATH = dirname(realGit);

    await expect(client.raw(['--version'])).resolves.toMatch(/^git version /);
    expect(existsSync(join(shimDir, 'used'))).toBe(true);
  });

  itUnix('runs the PATH git when its directory has a space in its name', async () => {
    const realGit = pathGit();
    const root = tracked(createTempDir('splitbrief-git-space'));
    const shimDir = join(root, 'Git Tools');
    mkdirSync(shimDir);
    const shim = gitShim(shimDir, realGit);
    const marker = join(shimDir, 'used');
    const repo = tracked(createTempDir('splitbrief-git-space-repo'));
    execFileSync(realGit, ['init', '--quiet'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    process.env.PATH = [shimDir, originalPath].join(delimiter);

    expect(gitBinary()).toBe(shim);
    await expect(createGitClient(repo).revparse(['--is-inside-work-tree'])).resolves.toBe('true');
    expect(existsSync(marker)).toBe(true);

    rmSync(marker);
    await expect(checkIgnoredPaths(repo, ['ignored.txt', 'kept.txt'])).resolves.toEqual([
      'ignored.txt',
    ]);
    expect(existsSync(marker)).toBe(true);
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
