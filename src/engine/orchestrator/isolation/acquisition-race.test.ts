import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { captureAcquisitionBaseline } from '../approval/file-snapshots/entry.js';
import { prepareWorktreeAcquisition } from './acquisition.js';

const race = vi.hoisted(() => ({
  afterRename: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      if (
        basename(String(args[1])) === 'isolation-baseline.json' &&
        race.afterRename !== undefined
      ) {
        const action = race.afterRename;
        race.afterRename = undefined;
        await action();
      }
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  race.afterRename = undefined;
  for (const root of roots.splice(0)) cleanupTempDir(root);
});
it.each(['a', '.gitignore'])(
  'preserves a concurrent edit to %s during baseline persistence and a later target edit',
  async (file) => {
    const root = createTempDir('validator-f3b-race');
    roots.push(root);
    const projectDir = join(root, 'project');
    const worktreeDir = join(root, 'worker');
    for (const dir of [projectDir, worktreeDir]) {
      await mkdir(dir);
      execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
      await writeFile(join(dir, file), 'base');
    }
    const options = {
      projectDir,
      worktreeDir,
      sessionId: 's',
      initialTargetBaseline: undefined,
    };
    await prepareWorktreeAcquisition({
      ...options,
      initialTargetBaseline: await captureAcquisitionBaseline(projectDir),
    });
    const operatorBytes = Buffer.from([0x6f, 0x70, 0xff]);
    await writeFile(join(projectDir, file), operatorBytes);
    await chmod(join(projectDir, file), 0o751);
    race.afterRename = async () => {
      expect(await readFile(join(worktreeDir, file), 'utf8')).toBe('base');
      expect((await stat(join(worktreeDir, file))).mode & 0o777).toBe(0o644);
      await writeFile(join(worktreeDir, file), 'concurrent worker partial');
    };
    await prepareWorktreeAcquisition(options);
    expect(await readFile(join(worktreeDir, file), 'utf8')).toBe('concurrent worker partial');
    await writeFile(join(projectDir, file), 'operator second');
    await prepareWorktreeAcquisition(options);
    expect(await readFile(join(worktreeDir, file), 'utf8')).toBe('concurrent worker partial');
  },
);
