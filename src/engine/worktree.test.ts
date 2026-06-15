import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { initConfig } from '../core/config/load/io.js';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  detectWorktree,
  validateWorktreeName,
} from './worktree.js';
import {
  DIPTYCH_DIR,
  ACTIVE_FILE,
  CONFIG_FILE,
  STATE_FILE,
  SESSIONS_DIR,
  TREES_DIR,
  LOCKFILE,
} from '../core/paths.js';

let repoDir: string;
let git: SimpleGit;

async function initRepo(dir: string): Promise<SimpleGit> {
  createTestGitRepo(dir, { 'README.md': '# test\n' });
  return simpleGit(dir);
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'worktree-test-'));
  git = await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('worktree path confinement', () => {
  itUnix('rejects create when .trees is a symlink outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'worktree-outside-'));
    const project = mkdtempSync(join(tmpdir(), 'worktree-project-'));
    try {
      createTestGitRepo(project, { 'README.md': '# test\n' });
      const projectGit = simpleGit(project);
      symlinkSync(outside, join(project, TREES_DIR));
      await expect(
        createWorktree({ projectDir: project, slug: 'escape', git: projectGit }),
      ).rejects.toThrow('resolves outside the project root');
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  itUnix('rejects remove when .trees/<slug> resolves outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'worktree-outside-'));
    const project = mkdtempSync(join(tmpdir(), 'worktree-project-'));
    try {
      createTestGitRepo(project, { 'README.md': '# test\n' });
      const projectGit = simpleGit(project);
      await mkdir(join(project, TREES_DIR), { recursive: true });
      symlinkSync(outside, join(project, TREES_DIR, 'escape'));
      await expect(
        removeWorktree({ projectDir: project, slug: 'escape', git: projectGit }),
      ).rejects.toThrow('resolves outside the project root');
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('createWorktree', () => {
  it('creates a directory at .trees/<slug> with a .git file', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-a', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-a');
    expect(existsSync(wtPath)).toBe(true);
    const gitMarker = join(wtPath, '.git');
    expect(existsSync(gitMarker)).toBe(true);
    expect(statSync(gitMarker).isFile()).toBe(true);
  });

  it('creates a branch named diptych/<slug> in the main repo', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-b', git });
    const branches = await git.branch();
    expect(branches.all).toContain('diptych/feat-b');
  });

  it('throws when the branch diptych/<slug> already exists', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-c', git });
    await expect(createWorktree({ projectDir: repoDir, slug: 'feat-c', git })).rejects.toThrow(
      'Branch diptych/feat-c already exists',
    );
  });

  it('hands a git-valid prune remediation when retry-create hits the stale branch (F-392)', async () => {
    // Out-of-band `rm -rf .trees/feat-stale` leaves the branch behind, so a
    // retry create trips branchExists. Its remediation must spell out the
    // prune-then-delete sequence git actually accepts, not a bare `git branch
    // -D` that git refuses while the worktree registration lingers.
    await createWorktree({ projectDir: repoDir, slug: 'feat-stale', git });
    rmSync(join(repoDir, TREES_DIR, 'feat-stale'), { recursive: true, force: true });
    expect((await git.branch()).all).toContain('diptych/feat-stale');

    await expect(createWorktree({ projectDir: repoDir, slug: 'feat-stale', git })).rejects.toThrow(
      'git worktree prune" then "git branch -D diptych/feat-stale',
    );
  });

  it('refuses to create a worktree when the source working tree is dirty', async () => {
    await writeFile(join(repoDir, 'dirty.txt'), 'uncommitted');

    await expect(createWorktree({ projectDir: repoDir, slug: 'feat-dirty', git })).rejects.toThrow(
      'Source working tree is dirty (1 uncommitted file(s): dirty.txt)',
    );

    expect(existsSync(join(repoDir, TREES_DIR, 'feat-dirty'))).toBe(false);
  });

  it('does not count files inside .trees/ as dirty when creating another worktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-pre', git });
    // Re-stat: the existing worktree adds untracked entries under .trees/
    // that should be ignored by the dirty check.
    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-second', git }),
    ).resolves.toBeDefined();
    expect(existsSync(join(repoDir, TREES_DIR, 'feat-second'))).toBe(true);
  });

  it('succeeds on a committed repo whose only dirt is initConfig .gitignore bookkeeping', async () => {
    // initConfig appends `.diptych/` and `.trees/` to .gitignore (F-432); that
    // self-authored delta must not trip the source-dirty gate.
    initConfig(repoDir);

    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-bookkeeping', git }),
    ).resolves.toBeDefined();
    expect(existsSync(join(repoDir, TREES_DIR, 'feat-bookkeeping'))).toBe(true);
  });

  it('still names a user-edited .gitignore beyond the bookkeeping lines as dirty', async () => {
    initConfig(repoDir);
    // A real user edit on top of the bookkeeping lines is genuine dirt.
    await writeFile(join(repoDir, '.gitignore'), '.diptych/\n.trees/\nnode_modules/\n');

    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-user-edit', git }),
    ).rejects.toThrow('uncommitted file(s): .gitignore');
    expect(existsSync(join(repoDir, TREES_DIR, 'feat-user-edit'))).toBe(false);
  });

  it.each([
    ['empty string', ''],
    ['leading dot', '.hidden'],
    ['leading dash', '-flag'],
    ['exactly ..', '..'],
    ['containing slash', 'feat/x'],
    ['containing backslash', 'feat\\x'],
    ['containing path traversal', '../escape'],
    ['containing space', 'feat x'],
    ['containing semicolon', 'feat;rm'],
    ['containing pipe', 'feat|x'],
    ['containing ampersand', 'feat&x'],
    ['containing dollar', 'feat$x'],
    ['containing backtick', 'feat`x'],
    ['containing newline', 'feat\nx'],
    ['containing null byte', 'feat\x00x'],
    ['containing glob', 'feat*x'],
    ['containing question mark', 'feat?x'],
    ['containing tilde', 'feat~x'],
    ['containing parentheses', 'feat(x)'],
    ['exceeding length limit', 'a'.repeat(65)],
  ])('rejects an invalid worktree name (%s)', async (_label, slug) => {
    await expect(createWorktree({ projectDir: repoDir, slug, git })).rejects.toThrow();
    // No branch should ever be created for an invalid name. (We skip the
    // .trees/<slug> existence check for path-traversal slugs like "..",
    // which trivially resolve to existing directories.)
    const branches = await git.branch();
    expect(branches.all).not.toContain(`diptych/${slug}`);
  });

  it.each([
    'feat-x',
    'feature_42',
    'a.b.c',
    'X1',
    '_internal',
    'a',
  ])('accepts a valid worktree name "%s"', async (slug) => {
    await expect(createWorktree({ projectDir: repoDir, slug, git })).resolves.toBeDefined();
    expect(existsSync(join(repoDir, TREES_DIR, slug))).toBe(true);
  });

  it('carries the base .diptych/config.yaml into the new worktree', async () => {
    const ignoredRepo = await mkdtemp(join(tmpdir(), 'worktree-config-'));
    try {
      createTestGitRepo(ignoredRepo, {
        'README.md': '# test\n',
        '.gitignore': '.diptych/\n.trees/\n',
      });
      const ignoredGit = simpleGit(ignoredRepo);
      const configBody = 'version: 3\nimplementer:\n  kind: api\n  provider: ollama\n';
      await mkdir(join(ignoredRepo, DIPTYCH_DIR), { recursive: true });
      await writeFile(join(ignoredRepo, DIPTYCH_DIR, CONFIG_FILE), configBody);

      const wtPath = await createWorktree({
        projectDir: ignoredRepo,
        slug: 'feat-cfg',
        git: ignoredGit,
      });

      const propagated = await readFile(join(wtPath, DIPTYCH_DIR, CONFIG_FILE), 'utf-8');
      expect(propagated).toBe(configBody);
    } finally {
      await rm(ignoredRepo, { recursive: true, force: true });
    }
  });

  it('populates submodules in the new worktree instead of leaving empty dirs (F-405)', async () => {
    // `git worktree add` does not initialize submodules; without an explicit
    // `submodule update --init`, the worktree's submodule dir is empty and
    // `git status` stays clean, hiding the hole. Use a real submodule repo so
    // the populated file is the observable proof.
    const superRepo = await mkdtemp(join(tmpdir(), 'worktree-super-'));
    const subRepo = await mkdtemp(join(tmpdir(), 'worktree-sub-'));
    // Modern git refuses `file://` submodule transports by default. Allow it via
    // the env var so both the setup commands and the submodule update that
    // createWorktree runs in the linked worktree inherit the allowance.
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

describe('listWorktrees', () => {
  it('returns [] when .trees/ does not exist', async () => {
    const result = await listWorktrees(repoDir);
    expect(result).toEqual([]);
  });

  it('returns one entry after createWorktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-d', git });
    const result = await listWorktrees(repoDir);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe('feat-d');
    expect(entry.branch).toBe('diptych/feat-d');
  });

  it('reports status "none" when no .diptych/active exists in the worktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-e', git });
    const result = await listWorktrees(repoDir);
    const entry = result[0]!;
    expect(entry.status).toBe('none');
    expect(entry.sessionId).toBeNull();
  });

  it('reports status "active" when .diptych/active exists and state is implementing', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-f', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-f');
    const diptychDir = join(wtPath, DIPTYCH_DIR);
    const sessionId = 'test-session-001';
    const sessionDir = join(diptychDir, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(diptychDir, ACTIVE_FILE), sessionId + '\n');
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));

    const result = await listWorktrees(repoDir);
    const entry = result[0]!;
    expect(entry.status).toBe('active');
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.phase).toBe('implementing');
    expect(entry.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports status "idle" when state is complete', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-g', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-g');
    const diptychDir = join(wtPath, DIPTYCH_DIR);
    const sessionId = 'test-session-002';
    const sessionDir = join(diptychDir, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(diptychDir, ACTIVE_FILE), sessionId + '\n');
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'complete' }));

    const result = await listWorktrees(repoDir);
    const entry = result[0]!;
    expect(entry.status).toBe('idle');
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.phase).toBe('complete');
    expect(entry.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports status "active" for a non-terminal session with no .diptych/active pointer', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-tui', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-tui');
    const sessionId = 'tui-session-001';
    const sessionDir = join(wtPath, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));

    const result = await listWorktrees(repoDir);
    const entry = result[0]!;
    expect(entry.status).toBe('active');
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.phase).toBe('implementing');
  });
});

describe('removeWorktree', () => {
  it('removes the directory and the git worktree registration', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-h', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-h');
    expect(existsSync(wtPath)).toBe(true);

    await removeWorktree({ projectDir: repoDir, slug: 'feat-h', git });
    expect(existsSync(wtPath)).toBe(false);

    const worktreeList = await git.raw(['worktree', 'list', '--porcelain']);
    expect(worktreeList).not.toContain('feat-h');
  });

  it('throws for a non-existent worktree', async () => {
    await expect(removeWorktree({ projectDir: repoDir, slug: 'nonexistent', git })).rejects.toThrow(
      'Worktree ".trees/nonexistent" does not exist.',
    );
  });

  it('prunes a stale registration and deletes the branch when the dir was removed out-of-band', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-gone', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-gone');
    // Simulate `rm -rf .trees/feat-gone`: the dir vanishes but git's worktree
    // registration and the diptych/feat-gone branch persist.
    rmSync(wtPath, { recursive: true, force: true });
    const before = await git.raw(['worktree', 'list', '--porcelain']);
    expect(before).toContain('feat-gone');
    expect((await git.branch()).all).toContain('diptych/feat-gone');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-gone', git, deleteBranch: true });

    const after = await git.raw(['worktree', 'list', '--porcelain']);
    expect(after).not.toContain('feat-gone');
    expect((await git.branch()).all).not.toContain('diptych/feat-gone');
  });

  it('refuses when a live session exists (without force)', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-i', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-i');
    const diptychDir = join(wtPath, DIPTYCH_DIR);
    const sessionId = 'live-session-001';
    const sessionDir = join(diptychDir, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(diptychDir, ACTIVE_FILE), sessionId + '\n');
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));

    await expect(removeWorktree({ projectDir: repoDir, slug: 'feat-i', git })).rejects.toThrow(
      `Worktree ".trees/feat-i" has a live session ${sessionId}`,
    );
  });

  it('refuses a non-terminal session with no .diptych/active pointer (TUI run)', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-tui-rm', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-tui-rm');
    const sessionId = 'tui-session-rm';
    const sessionDir = join(wtPath, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));

    await expect(removeWorktree({ projectDir: repoDir, slug: 'feat-tui-rm', git })).rejects.toThrow(
      `Worktree ".trees/feat-tui-rm" has a live session ${sessionId}`,
    );
    expect(existsSync(wtPath)).toBe(true);
  });

  it('allows removal when a non-terminal session has an exited server lockfile', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-dead', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-dead');
    await writeFile(join(wtPath, '.gitignore'), '.diptych/\n.trees/\n');
    const sessionId = 'feat-dead';
    const sessionDir = join(wtPath, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));
    await writeFile(
      join(sessionDir, LOCKFILE),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId,
        mode: 'standard',
        feature: 'dead session',
        exitedAt: Date.now(),
      }),
    );

    await removeWorktree({ projectDir: repoDir, slug: 'feat-dead', git });
    expect(existsSync(wtPath)).toBe(false);
  });

  it('refuses when uncommitted changes exist (without force)', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-j', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-j');
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted change');

    await expect(removeWorktree({ projectDir: repoDir, slug: 'feat-j', git })).rejects.toThrow(
      'Worktree ".trees/feat-j" has uncommitted changes',
    );
  });

  it('removes without --force when the only dirt is in-worktree initConfig bookkeeping', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-bk-rm', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-bk-rm');
    // initConfig inside the worktree writes the same `.diptych/` / `.trees/`
    // bookkeeping (F-432); that delta must not trip the cleanliness gate.
    initConfig(wtPath);

    await removeWorktree({ projectDir: repoDir, slug: 'feat-bk-rm', git });
    expect(existsSync(wtPath)).toBe(false);
  });

  it('proceeds with force=true and logs both bypassed guards to stderr', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-k', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-k');
    const diptychDir = join(wtPath, DIPTYCH_DIR);
    const sessionId = 'live-session-force';
    const sessionDir = join(diptychDir, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(diptychDir, ACTIVE_FILE), sessionId + '\n');
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted change');

    // last-resort: stderr is the observable output for force-remove warnings
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-k', git, force: true });

    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.some((msg) => msg.includes(`live session ${sessionId}`))).toBe(true);
    expect(stderrCalls.some((msg) => msg.includes('2 uncommitted file(s)'))).toBe(true);
    expect(existsSync(wtPath)).toBe(false);

    stderrSpy.mockRestore();
  });

  it('deletes the branch when deleteBranch=true', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-l', git });
    const branchesBefore = await git.branch();
    expect(branchesBefore.all).toContain('diptych/feat-l');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-l', git, deleteBranch: true });

    const branchesAfter = await git.branch();
    expect(branchesAfter.all).not.toContain('diptych/feat-l');
  });
});

describe('detectWorktree', () => {
  it('returns null in the main worktree', async () => {
    const result = await detectWorktree(repoDir, git);
    expect(result).toBeNull();
  });

  it('returns the slug when called from inside a linked worktree', async () => {
    const slug = 'feat-m';
    await createWorktree({ projectDir: repoDir, slug, git });
    const wtPath = join(repoDir, TREES_DIR, slug);
    const wtGit = simpleGit(wtPath);
    const result = await detectWorktree(wtPath, wtGit);
    expect(result).toBe(slug);
  });

  it('returns null on error (non-git directory)', async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), 'not-a-git-'));
    try {
      const nonGit = simpleGit(nonGitDir);
      const result = await detectWorktree(nonGitDir, nonGit);
      expect(result).toBeNull();
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe('validateWorktreeName', () => {
  it('rejects a 65-character name with the nameTooLong error', () => {
    expect(() => validateWorktreeName('a'.repeat(65))).toThrow('is too long (max 64 characters)');
  });

  it('accepts a 64-character name at the boundary', () => {
    expect(() => validateWorktreeName('a'.repeat(64))).not.toThrow();
  });
});
