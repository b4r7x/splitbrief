import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleGit, type SimpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createWorktree } from './create.js';
import { listWorktrees } from './status.js';
import { DIPTYCH_DIR, ACTIVE_FILE, STATE_FILE, SESSIONS_DIR, TREES_DIR } from '../../core/paths.js';

let repoDir: string;
let git: SimpleGit;

async function initRepo(dir: string): Promise<SimpleGit> {
  createTestGitRepo(dir, { 'README.md': '# test\n' });
  return simpleGit(dir);
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'worktree-status-test-'));
  git = await initRepo(repoDir);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('listWorktrees', () => {
  it('returns [] when .trees/ does not exist', async () => {
    const result = await listWorktrees(repoDir);
    expect(result).toEqual([]);
  });

  it('returns one entry with name, branch, status, and sessionId after createWorktree', async () => {
    await createWorktree({ projectDir: repoDir, slug: 'feat-d', git });
    const result = await listWorktrees(repoDir);
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe('feat-d');
    expect(entry.branch).toBe('diptych/feat-d');
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
