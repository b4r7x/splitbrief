import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  detectWorktree,
} from './worktree.js';
import { DIPTYCH_DIR, ACTIVE_FILE, STATE_FILE, SESSIONS_DIR, TREES_DIR } from '../../core/paths.js';

let repoDir: string;
let git: SimpleGit;

async function initRepo(dir: string): Promise<SimpleGit> {
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig('user.email', 'test@test.test');
  await g.addConfig('user.name', 'Test');
  await writeFile(join(dir, 'README.md'), '# test\n');
  await g.add('README.md');
  await g.commit('initial commit');
  return g;
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'worktree-test-'));
  git = await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
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
    await expect(
      createWorktree({ projectDir: repoDir, slug: 'feat-c', git }),
    ).rejects.toThrow('Branch diptych/feat-c already exists');
  });
});

describe('listWorktrees', () => {
  it('returns [] when .trees/ does not exist', async () => {
    const result = await listWorktrees(repoDir, git);
    expect(result).toEqual([]);
  });

  it('returns one entry after createWorktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-d', git });
    const result = await listWorktrees(repoDir, git);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe('feat-d');
    expect(entry.branch).toBe('diptych/feat-d');
  });

  it('reports status "none" when no .diptych/active exists in the worktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-e', git });
    const result = await listWorktrees(repoDir, git);
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

    const result = await listWorktrees(repoDir, git);
    const entry = result[0]!;
    expect(entry.status).toBe('active');
    expect(entry.sessionId).toBe(sessionId);
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

    const result = await listWorktrees(repoDir, git);
    const entry = result[0]!;
    expect(entry.status).toBe('idle');
    expect(entry.sessionId).toBe(sessionId);
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
    await expect(
      removeWorktree({ projectDir: repoDir, slug: 'nonexistent', git }),
    ).rejects.toThrow('Worktree ".trees/nonexistent" does not exist.');
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

    await expect(
      removeWorktree({ projectDir: repoDir, slug: 'feat-i', git }),
    ).rejects.toThrow(`Worktree ".trees/feat-i" has a live session ${sessionId}`);
  });

  it('refuses when uncommitted changes exist (without force)', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-j', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-j');
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted change');

    await expect(
      removeWorktree({ projectDir: repoDir, slug: 'feat-j', git }),
    ).rejects.toThrow('Worktree ".trees/feat-j" has uncommitted changes');
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

    const stderrSpy = vi.spyOn(process.stderr, 'write');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-k', git, force: true });

    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.some((msg) => msg.includes('live session'))).toBe(true);
    expect(stderrCalls.some((msg) => msg.includes('uncommitted changes'))).toBe(true);
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
