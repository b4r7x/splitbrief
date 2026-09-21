import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { initConfig } from '../../../core/config/load/io.js';
import { createWorktree } from './create-worktree.js';
import { removeWorktree } from './remove-worktree.js';
import {
  SPLITBRIEF_DIR,
  ACTIVE_FILE,
  STATE_FILE,
  SESSIONS_DIR,
  TREES_DIR,
  LOCKFILE,
} from '../../../core/paths.js';

let repoDir: string;
let git: SimpleGit;

async function initRepo(dir: string): Promise<SimpleGit> {
  createTestGitRepo(dir, { 'README.md': '# test\n' });
  return simpleGit(dir);
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'worktree-remove-test-'));
  git = await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
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
    rmSync(wtPath, { recursive: true, force: true });
    const before = await git.raw(['worktree', 'list', '--porcelain']);
    expect(before).toContain('feat-gone');
    expect((await git.branch()).all).toContain('splitbrief/feat-gone');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-gone', git, deleteBranch: true });

    const after = await git.raw(['worktree', 'list', '--porcelain']);
    expect(after).not.toContain('feat-gone');
    expect((await git.branch()).all).not.toContain('splitbrief/feat-gone');
  });

  it('warns about a non-terminal session with no .splitbrief/active pointer (TUI run)', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-tui-rm', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-tui-rm');
    const sessionId = 'tui-session-rm';
    const sessionDir = join(wtPath, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));
    const warningPublisher = vi.fn();

    await removeWorktree({ projectDir: repoDir, slug: 'feat-tui-rm', git, warningPublisher });

    expect(String(warningPublisher.mock.calls[0]?.[0])).toContain(`live session ${sessionId}`);
    expect(existsSync(wtPath)).toBe(false);
  });

  it('does not warn when a non-terminal session has an exited server lockfile', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-dead', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-dead');
    await writeFile(join(wtPath, '.gitignore'), '.splitbrief/\n.trees/\n');
    const sessionId = 'feat-dead';
    const sessionDir = join(wtPath, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId);
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

    const warningPublisher = vi.fn();
    await removeWorktree({ projectDir: repoDir, slug: 'feat-dead', git, warningPublisher });
    expect(warningPublisher).not.toHaveBeenCalled();
    expect(existsSync(wtPath)).toBe(false);
  });

  it('does not warn when the only dirt is in-worktree initConfig bookkeeping', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-bk-rm', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-bk-rm');
    await initConfig(wtPath);
    const warningPublisher = vi.fn();

    await removeWorktree({ projectDir: repoDir, slug: 'feat-bk-rm', git, warningPublisher });
    expect(warningPublisher).not.toHaveBeenCalled();
    expect(existsSync(wtPath)).toBe(false);
  });

  it('removeWorktree with a publisher routes warnings through it and writes nothing to stderr', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-pub', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-pub');
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted change');

    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const warningPublisher = vi.fn();

    await removeWorktree({
      projectDir: repoDir,
      slug: 'feat-pub',
      git,
      warningPublisher,
    });

    expect(stderrSpy.mock.calls).toHaveLength(0);
    expect(warningPublisher).toHaveBeenCalledOnce();
    expect(String(warningPublisher.mock.calls[0]?.[0])).toContain('1 uncommitted file(s)');
    expect(existsSync(wtPath)).toBe(false);

    stderrSpy.mockRestore();
  });

  it('logs both bypassed guards to stderr when no publisher is supplied', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-k', git });
    const wtPath = join(repoDir, TREES_DIR, 'feat-k');
    const splitbriefDir = join(wtPath, SPLITBRIEF_DIR);
    const sessionId = 'live-session-force';
    const sessionDir = join(splitbriefDir, SESSIONS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(splitbriefDir, ACTIVE_FILE), sessionId + '\n');
    await writeFile(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));
    await writeFile(join(wtPath, 'dirty.txt'), 'uncommitted change');

    const stderrSpy = vi.spyOn(process.stderr, 'write');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-k', git });

    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(stderrCalls.some((msg) => msg.includes(`live session ${sessionId}`))).toBe(true);
    expect(stderrCalls.some((msg) => msg.includes('2 uncommitted file(s)'))).toBe(true);
    expect(existsSync(wtPath)).toBe(false);

    stderrSpy.mockRestore();
  });

  it('deletes the branch when deleteBranch=true', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-l', git });
    const branchesBefore = await git.branch();
    expect(branchesBefore.all).toContain('splitbrief/feat-l');

    await removeWorktree({ projectDir: repoDir, slug: 'feat-l', git, deleteBranch: true });

    const branchesAfter = await git.branch();
    expect(branchesAfter.all).not.toContain('splitbrief/feat-l');
  });
});
