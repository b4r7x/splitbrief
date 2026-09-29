import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { captureAcquisitionBaseline } from '../approval/file-snapshots/entry.js';
import { promoteStagedChanges } from '../approval/staged-project.js';
import { prepareWorktreeAcquisition } from './acquisition.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanupTempDir(root);
});

async function fixture(initialize = true) {
  const root = createTempDir('isolation-acquisition');
  roots.push(root);
  const projectDir = join(root, 'project');
  const worktreeDir = join(root, 'worker');
  for (const dir of [projectDir, worktreeDir]) {
    await mkdir(dir);
    // Ordinary unborn repositories exercise status and ignore rules without
    // staging, committing, or creating a linked worktree.
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    await writeFile(join(dir, 'app.ts'), 'original\n');
    await writeFile(join(dir, 'keep.ts'), 'keep\n');
  }
  const acquire = (fresh = false) =>
    prepareWorktreeAcquisition({
      projectDir,
      sessionId: 'parked-run',
      worktreeDir,
      seedSnapshot: null,
      initialTargetBaseline: undefined,
      fresh,
    });
  if (initialize) {
    await prepareWorktreeAcquisition({
      projectDir,
      sessionId: 'parked-run',
      worktreeDir,
      seedSnapshot: null,
      initialTargetBaseline: await captureAcquisitionBaseline(projectDir),
      fresh: false,
    });
  }
  const promote = async (files: string[], fresh = false) =>
    promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: worktreeDir,
      files,
      targetBaseline: (await acquire(fresh)).targetBaseline,
    });
  return { projectDir, worktreeDir, acquire, promote };
}

describe('retained worktree acquisition', () => {
  it('keeps distinct gitignore bookkeeping out of the operator-edit comparison', async () => {
    const { projectDir, worktreeDir, acquire } = await fixture(false);
    await writeFile(join(projectDir, '.gitignore'), 'node_modules/\n');
    await writeFile(join(worktreeDir, '.gitignore'), 'node_modules/\n.splitbrief/\n');
    await prepareWorktreeAcquisition({
      projectDir,
      sessionId: 'parked-run',
      worktreeDir,
      seedSnapshot: null,
      initialTargetBaseline: await captureAcquisitionBaseline(projectDir),
      fresh: false,
    });
    await writeFile(join(projectDir, '.gitignore'), 'node_modules/\ncoverage/\n');

    await acquire();
    expect(await readFile(join(worktreeDir, '.gitignore'), 'utf8')).toContain('coverage/');
    expect(await readFile(join(worktreeDir, '.gitignore'), 'utf8')).toContain('.splitbrief/');
    expect(await readFile(join(projectDir, '.gitignore'), 'utf8')).toBe(
      'node_modules/\ncoverage/\n',
    );
  });

  it('loads operator edits into an unchanged worker copy on cold resume', async () => {
    const { projectDir, worktreeDir, acquire } = await fixture();
    await writeFile(join(projectDir, 'app.ts'), 'operator\n');

    const workspace = await acquire();
    expect(await readFile(join(worktreeDir, 'app.ts'), 'utf8')).toBe('operator\n');
    await writeFile(join(worktreeDir, 'app.ts'), 'operator plus worker\n');
    const result = await promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: worktreeDir,
      files: ['app.ts'],
      targetBaseline: workspace.targetBaseline,
    });
    expect(result.conflictedFiles).toEqual([]);
    expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('operator plus worker\n');
  });

  it('keeps worker-only partial output promotable after a cold resume', async () => {
    const { projectDir, worktreeDir, acquire, promote } = await fixture();
    await writeFile(join(worktreeDir, 'app.ts'), 'worker partial\n');

    await acquire();
    expect(await readFile(join(worktreeDir, 'app.ts'), 'utf8')).toBe('worker partial\n');
    expect((await promote(['app.ts'])).conflictedFiles).toEqual([]);
    expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('worker partial\n');
  });

  it.each([false, true])(
    'preserves both edits and keeps the conflict across repeated resumes, fresh=%s',
    async (fresh) => {
      const { projectDir, worktreeDir, acquire, promote } = await fixture();
      await writeFile(join(worktreeDir, 'app.ts'), 'worker partial\n');
      await writeFile(join(projectDir, 'app.ts'), 'operator\n');

      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await acquire(fresh)).discarded).toEqual([]);
        const result = await promote(['app.ts'], fresh);
        expect(result.conflictedFiles).toEqual(['app.ts']);
        expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('operator\n');
        expect(await readFile(join(worktreeDir, 'app.ts'), 'utf8')).toBe('worker partial\n');
      }

      // The operator reconciles both copies. The next acquisition can promote
      // further work without resetting the run or removing its workspace.
      await writeFile(join(projectDir, 'app.ts'), 'merged\n');
      await writeFile(join(worktreeDir, 'app.ts'), 'merged\n');
      const workspace = await acquire();
      await writeFile(join(worktreeDir, 'app.ts'), 'merged and finished\n');
      const result = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: worktreeDir,
        files: ['app.ts'],
        targetBaseline: workspace.targetBaseline,
      });
      expect(result.conflictedFiles).toEqual([]);
      expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('merged and finished\n');
    },
  );

  it('syncs operator additions, deletion, binary bytes and modes while preserving a partial', async () => {
    const { projectDir, worktreeDir, acquire, promote } = await fixture();
    await writeFile(join(worktreeDir, 'keep.ts'), 'worker partial\n');
    await rm(join(projectDir, 'app.ts'));
    await writeFile(join(projectDir, 'new.bin'), Buffer.from([0xff, 0x00, 0xfe]));
    await chmod(join(projectDir, 'new.bin'), 0o755);

    await acquire();
    await expect(readFile(join(worktreeDir, 'app.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(worktreeDir, 'new.bin'))).toEqual(Buffer.from([0xff, 0x00, 0xfe]));
    if (process.platform !== 'win32') {
      expect((await stat(join(worktreeDir, 'new.bin'))).mode & 0o777).toBe(0o755);
    }
    expect(await readFile(join(worktreeDir, 'keep.ts'), 'utf8')).toBe('worker partial\n');
    expect((await promote(['keep.ts'])).conflictedFiles).toEqual([]);
    expect(await readFile(join(projectDir, 'keep.ts'), 'utf8')).toBe('worker partial\n');
  });

  it('preserves ambiguous legacy partials without manufacturing a fresh target baseline', async () => {
    const { projectDir, worktreeDir, acquire, promote } = await fixture(false);
    await writeFile(join(worktreeDir, 'app.ts'), 'legacy partial\n');
    await writeFile(join(projectDir, 'app.ts'), 'operator\n');

    for (let attempt = 0; attempt < 2; attempt++) {
      await acquire(true);
      expect((await promote(['app.ts'])).conflictedFiles).toEqual(['app.ts']);
      expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('operator\n');
      expect(await readFile(join(worktreeDir, 'app.ts'), 'utf8')).toBe('legacy partial\n');
    }
  });

  it('continues to reject edits made after the refreshed acquisition', async () => {
    const { projectDir, worktreeDir, acquire } = await fixture();
    await writeFile(join(projectDir, 'app.ts'), 'operator before resume\n');
    const workspace = await acquire();
    await writeFile(join(worktreeDir, 'app.ts'), 'worker\n');
    await writeFile(join(projectDir, 'app.ts'), 'operator during call\n');

    const result = await promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: worktreeDir,
      files: ['app.ts'],
      targetBaseline: workspace.targetBaseline,
    });
    expect(result.conflictedFiles).toEqual(['app.ts']);
    expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('operator during call\n');
  });

  it.runIf(process.platform !== 'win32')(
    'refuses acquisition when the atomic baseline update fails and preserves recoverable work',
    async () => {
      const { projectDir, worktreeDir, acquire, promote } = await fixture();
      const baselinePath = join(
        projectDir,
        '.splitbrief/sessions/parked-run/isolation-baseline.json',
      );
      const previous = await readFile(baselinePath, 'utf8');
      await writeFile(join(worktreeDir, 'keep.ts'), 'worker partial\n');
      await writeFile(join(projectDir, 'app.ts'), 'operator\n');
      await chmod(dirname(baselinePath), 0o500);
      try {
        await expect(acquire()).rejects.toMatchObject({ code: 'EACCES' });
        expect(await readFile(baselinePath, 'utf8')).toBe(previous);
        expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('operator\n');
        expect(await readFile(join(worktreeDir, 'keep.ts'), 'utf8')).toBe('worker partial\n');
      } finally {
        await chmod(dirname(baselinePath), 0o700);
      }
      await acquire();
      expect((await promote(['keep.ts'])).conflictedFiles).toEqual([]);
      expect(await readFile(join(projectDir, 'keep.ts'), 'utf8')).toBe('worker partial\n');
    },
  );

  it('refuses malformed durable inputs without synchronizing either copy', async () => {
    const { projectDir, worktreeDir, acquire } = await fixture();
    const baselinePath = join(
      projectDir,
      '.splitbrief/sessions/parked-run/isolation-baseline.json',
    );
    await writeFile(baselinePath, '{"version":1,"targetFiles":null}');
    await writeFile(join(projectDir, 'app.ts'), 'operator\n');
    await writeFile(join(worktreeDir, 'app.ts'), 'worker partial\n');

    await expect(acquire()).rejects.toMatchObject({ kind: 'isolation-baseline-invalid' });
    expect(await readFile(join(projectDir, 'app.ts'), 'utf8')).toBe('operator\n');
    expect(await readFile(join(worktreeDir, 'app.ts'), 'utf8')).toBe('worker partial\n');
  });
});
