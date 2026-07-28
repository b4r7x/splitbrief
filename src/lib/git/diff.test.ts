import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getCurrentDiff, getDiffSince, getCommittedFilesSince } from './diff.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('splitbrief-git-test');
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

describe('getCurrentDiff', () => {
  it('returns combined staged and unstaged diff', async () => {
    const dir = tracked(setupGitRepo());
    writeFileSync(join(dir, 'staged-marker.txt'), 'STAGED_MARKER_BODY');
    execSync('git add staged-marker.txt', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'init.txt'), 'UNSTAGED_MARKER_BODY');
    const diff = await getCurrentDiff(dir);
    expect(diff).toContain('STAGED_MARKER_BODY');
    expect(diff).toContain('UNSTAGED_MARKER_BODY');
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

describe('getDiffSince', () => {
  it('includes both committed-since-base changes and untracked working-tree files', async () => {
    const dir = tracked(setupGitRepo());
    const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    writeFileSync(join(dir, 'committed.txt'), 'COMMITTED_BODY');
    execSync('git add committed.txt && git commit -m "feat(splitbrief): T001"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'untracked.txt'), 'UNTRACKED_BODY');

    const diff = await getDiffSince(dir, base);
    expect(diff).toContain('COMMITTED_BODY');
    expect(diff).toContain('UNTRACKED_BODY');
  });
});

describe('getCommittedFilesSince', () => {
  it('returns the committed path verbatim for a non-ASCII filename', async () => {
    const dir = tracked(setupGitRepo());
    const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    writeFileSync(join(dir, 'résumé.md'), 'body');
    execSync('git add "résumé.md" && git commit -m "feat(splitbrief): T001"', {
      cwd: dir,
      stdio: 'pipe',
    });

    const committed = await getCommittedFilesSince(dir, base);
    expect(committed).toContain('résumé.md');
  });
});
