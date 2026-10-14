import { appendFile, mkdtemp, rm, writeFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { existsSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { initConfig } from '../../../core/config/load/io.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { createWorktree } from './create-worktree.js';
import { SPLITBRIEF_DIR, CONFIG_FILE, TREES_DIR } from '../../../core/paths.js';

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
  it('creates a worktree from a dirty source without inspecting source cleanliness', async () => {
    await writeFile(join(repoDir, 'dirty.txt'), 'uncommitted');

    const wtPath = await createWorktree({ projectDir: repoDir, slug: 'feat-dirty', git });

    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, 'dirty.txt'))).toBe(false);
  });

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

  it('rejects path traversal via git and leaves no branch or worktree path', async () => {
    const slug = '../escape';
    await expect(createWorktree({ projectDir: repoDir, slug, git })).rejects.toThrow();
    const branches = await git.branch();
    expect(branches.all).not.toContain(`splitbrief/${slug}`);
    expect(existsSync(join(repoDir, TREES_DIR, slug))).toBe(false);
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
    await initConfig(repoDir, createDefaultConfig());

    const wtPath = await createWorktree({ projectDir: repoDir, slug: 'feat-ignore', git });

    const ignoreLines = (await readFile(join(wtPath, '.gitignore'), 'utf-8'))
      .split('\n')
      .map((line) => line.trim());
    expect(ignoreLines).toContain(`${SPLITBRIEF_DIR}/`);
    expect(ignoreLines).not.toContain(`${TREES_DIR}/`);
    expect(existsSync(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);
  });

  it('leaves the worktree .gitignore unchanged when the shared exclude file ignores .splitbrief/', async () => {
    const excludedRepo = await mkdtemp(join(tmpdir(), 'worktree-excluded-'));
    try {
      createTestGitRepo(excludedRepo, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
      await appendFile(join(excludedRepo, '.git', 'info', 'exclude'), `${SPLITBRIEF_DIR}/\n`);
      await initConfig(excludedRepo, createDefaultConfig());

      const wtPath = await createWorktree({
        projectDir: excludedRepo,
        slug: 'feat-excluded',
        git: simpleGit(excludedRepo),
      });

      expect(existsSync(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);
      expect(await readFile(join(wtPath, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
      expect(
        execFileSync('git', ['status', '--porcelain'], { cwd: wtPath, encoding: 'utf-8' }),
      ).toBe('');
    } finally {
      await rm(excludedRepo, { recursive: true, force: true });
    }
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

  it('passes the user transport environment to the submodule clone of the new worktree', async () => {
    createTestGitRepo(repoDir, {
      '.gitmodules':
        '[submodule "vendor"]\n\tpath = vendor\n\turl = ssh://splitbrief.invalid:2222/sub.git\n',
    });
    const head = (await git.revparse(['HEAD'])).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', '160000', head, 'vendor'], {
      cwd: repoDir,
    });
    execFileSync('git', ['commit', '-m', 'add ssh submodule'], { cwd: repoDir, stdio: 'pipe' });

    const sshCommand = join(repoDir, 'ssh.sh');
    const argvMarker = join(repoDir, 'ssh-argv');
    const environmentMarker = join(repoDir, 'ssh-env');
    await writeFile(
      sshCommand,
      `#!/bin/sh\nprintf "%s\\n" "$@" > "\${0%/*}/ssh-argv"\nenv > "\${0%/*}/ssh-env"\nexit 1\n`,
    );
    await chmod(sshCommand, 0o755);
    const environment = {
      GIT_ALLOW_PROTOCOL: 'ssh:https',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_SSH: '/splitbrief/ssh',
      GIT_SSH_COMMAND: `"${sshCommand}"`,
      GIT_SSH_VARIANT: 'ssh',
      GIT_ASKPASS: '/splitbrief/git-askpass',
      SSH_ASKPASS: '/splitbrief/ssh-askpass',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PROXY_COMMAND: '/splitbrief/proxy',
      GIT_PROXY_SSL_CAINFO: '/splitbrief/proxy-ca.pem',
      GIT_PROXY_SSL_CERT: '/splitbrief/proxy-cert.pem',
      GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED: 'false',
      GIT_PROXY_SSL_KEY: '/splitbrief/proxy-key.pem',
      GIT_SSL_CAINFO: '/splitbrief/ca.pem',
      GIT_SSL_CAPATH: '/splitbrief/ca',
      GIT_SSL_CERT: '/splitbrief/cert.pem',
      GIT_SSL_CERT_PASSWORD_PROTECTED: 'no',
      GIT_SSL_CIPHER_LIST: 'DEFAULT',
      GIT_SSL_KEY: '/splitbrief/key.pem',
      GIT_SSL_NO_VERIFY: 'true',
      GIT_SSL_VERSION: 'tlsv1.2',
      GIT_HTTP_LOW_SPEED_LIMIT: '7',
      GIT_HTTP_LOW_SPEED_TIME: '11',
      GIT_HTTP_MAX_REQUESTS: '3',
      GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
      GIT_HTTP_USER_AGENT: 'splitbrief-transport-test',
      GIT_CURL_FTP_NO_EPSV: 'off',
    };
    const previousEnvironment = new Map(
      [...Object.keys(environment), 'GIT_EDITOR'].map((key) => [key, process.env[key]]),
    );
    try {
      for (const [key, value] of Object.entries(environment)) process.env[key] = value;
      process.env.GIT_EDITOR = '/splitbrief/editor';
      await expect(
        createWorktree({ projectDir: repoDir, slug: 'feat-ssh-sub', git }),
      ).rejects.toThrow();
      const argv = (await readFile(argvMarker, 'utf-8')).split('\n');
      expect.soft(argv).toContain('-p');
      expect.soft(argv).toContain('2222');
      expect.soft(argv).not.toContain('-G');
      const childEnvironment = (await readFile(environmentMarker, 'utf-8')).split('\n');
      for (const [key, value] of Object.entries(environment)) {
        expect.soft(childEnvironment, key).toContain(`${key}=${value}`);
      }
      expect(childEnvironment.some((line) => line.startsWith('GIT_EDITOR='))).toBe(false);
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
