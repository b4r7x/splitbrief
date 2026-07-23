import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { createWorktree } from '../../../src/engine/worktree/create.js';
import { registerWorktreeCommand } from '../../../src/cli/commands/worktree.js';
import { createGitClient } from '../../../src/lib/git/client.js';
import {
  ACTIVE_FILE,
  DIPTYCH_DIR,
  SESSIONS_DIR,
  STATE_FILE,
  TREES_DIR,
} from '../../../src/core/paths.js';

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = createTempDir('worktree-remove-integration');
  createTestGitRepo(tmp, { 'README.md': '# test\n' });
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

function captureOutput(): string {
  return consoleSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
}

async function runWorktree(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerWorktreeCommand(program);
  await program.parseAsync(['node', 'diptych', 'worktree', ...args, '--project', tmp]);
}

describe('worktree remove — real command', () => {
  it('removes the worktree path', async () => {
    const git = createGitClient(tmp);
    await createWorktree({ projectDir: tmp, slug: 'feat-rm', git });
    const wtPath = join(tmp, TREES_DIR, 'feat-rm');
    expect(existsSync(wtPath)).toBe(true);

    await runWorktree(['remove', 'feat-rm']);

    expect(existsSync(wtPath)).toBe(false);
    expect(captureOutput()).toContain('Removed worktree ".trees/feat-rm".');
  });

  it('force-bypasses live-session and uncommitted-change guards', async () => {
    const git = createGitClient(tmp);
    await createWorktree({ projectDir: tmp, slug: 'feat-force', git });
    const wtPath = join(tmp, TREES_DIR, 'feat-force');
    const sessionId = 'live-session-force';
    const sessionDir = join(wtPath, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(wtPath, DIPTYCH_DIR, ACTIVE_FILE), `${sessionId}\n`);
    writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify({ phase: 'implementing' }));
    writeFileSync(join(wtPath, 'dirty.txt'), 'uncommitted change');

    await runWorktree(['remove', 'feat-force', '--force']);

    expect(existsSync(wtPath)).toBe(false);
    const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(stderr).toContain(`live session ${sessionId}`);
    expect(stderr).toMatch(/uncommitted file/);
    expect(captureOutput()).toContain('Removed worktree ".trees/feat-force".');
  });

  it('deletes the diptych branch when --delete-branch is set', async () => {
    const git = createGitClient(tmp);
    await createWorktree({ projectDir: tmp, slug: 'feat-branch', git });
    expect((await git.branch()).all).toContain('diptych/feat-branch');

    await runWorktree(['remove', 'feat-branch', '--delete-branch']);

    expect(existsSync(join(tmp, TREES_DIR, 'feat-branch'))).toBe(false);
    expect((await git.branch()).all).not.toContain('diptych/feat-branch');
    const out = captureOutput();
    expect(out).toContain('Removed worktree ".trees/feat-branch".');
    expect(out).toContain('Deleted branch diptych/feat-branch.');
  });
});
