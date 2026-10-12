import fs, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSnapshot } from '../create.js';
import { rejectRunSnapshot } from './lifecycle.js';
import { recordRunSnapshot } from './ledger.js';

let projectDir: string;
const sessionId = 'rollback';

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'splitbrief-rollback-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await rm(projectDir, { recursive: true, force: true });
});

async function recordRun(): Promise<void> {
  const snapshot = await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  await recordRunSnapshot(projectDir, sessionId, snapshot.manifest);
}

it('keeps a later symlink even when its target holds the run bytes', async () => {
  await writeFile(join(projectDir, 'source'), 'before');
  await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  await writeFile(join(projectDir, 'source'), 'run bytes');
  await recordRun();
  await rm(join(projectDir, 'source'));
  await writeFile(join(projectDir, 'user-target'), 'run bytes');
  await symlink('user-target', join(projectDir, 'source'));

  expect(await rejectRunSnapshot(projectDir, sessionId)).toMatchObject({
    status: 'rejected',
    conflictedPaths: ['source'],
    restoredPaths: [],
  });
  expect((await lstat(join(projectDir, 'source'))).isSymbolicLink()).toBe(true);
  await expect(readFile(join(projectDir, 'user-target'), 'utf8')).resolves.toBe('run bytes');
});

it('restores a deleted path whose parent directory is also absent', async () => {
  await mkdir(join(projectDir, 'src'));
  await writeFile(join(projectDir, 'src', 'source'), 'before');
  await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  await rm(join(projectDir, 'src'), { recursive: true });
  await recordRun();

  expect(await rejectRunSnapshot(projectDir, sessionId)).toMatchObject({
    status: 'rejected',
    restoredPaths: ['src/source'],
  });
  await expect(readFile(join(projectDir, 'src', 'source'), 'utf8')).resolves.toBe('before');
  expect((await stat(join(projectDir, 'src'))).mode & 0o777).toBe(0o777 & ~process.umask());
});

it('preserves the executable mode on a restored file and its saved replacement', async () => {
  await writeFile(join(projectDir, 'script'), 'before');
  await chmod(join(projectDir, 'script'), 0o751);
  await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  await writeFile(join(projectDir, 'script'), 'run bytes');
  await recordRun();

  const result = await rejectRunSnapshot(projectDir, sessionId);

  if (result.status !== 'rejected' || result.savedTo === undefined) {
    throw new Error('missing replaced file backup');
  }
  await expect(readFile(join(projectDir, 'script'), 'utf8')).resolves.toBe('before');
  expect((await stat(join(projectDir, 'script'))).mode & 0o777).toBe(0o751);
  expect((await stat(join(projectDir, result.savedTo, 'script'))).mode & 0o777).toBe(0o751);
});

it('recreates a file the run deleted with the mode it had before the run', async () => {
  await writeFile(join(projectDir, 'script'), 'before');
  await chmod(join(projectDir, 'script'), 0o751);
  await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  await rm(join(projectDir, 'script'));
  await recordRun();

  expect(await rejectRunSnapshot(projectDir, sessionId)).toMatchObject({
    status: 'rejected',
    restoredPaths: ['script'],
  });
  await expect(readFile(join(projectDir, 'script'), 'utf8')).resolves.toBe('before');
  expect((await stat(join(projectDir, 'script'))).mode & 0o777).toBe(0o751);
});

it.each(['restore', 'delete'] as const)(
  'keeps an edit made during rejection before %s',
  async (action) => {
    const file = join(projectDir, 'source');
    if (action === 'restore') await writeFile(file, 'before');
    await createSnapshot({ projectDir, sessionId, phase: 'manual' });
    await writeFile(file, 'run bytes');
    await recordRun();
    let changed = false;
    const originalReadFile = fs.readFile;
    const originalLink = fs.link;
    vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
      const bytes = await originalReadFile(path, options);
      if (action === 'restore' && !changed && String(path).includes('/baseline/files/')) {
        changed = true;
        await writeFile(file, 'later user edit');
      }
      return bytes;
    });
    vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (action === 'delete' && !changed && String(target).includes('/reverted/')) {
        changed = true;
        await writeFile(file, 'later user edit');
      }
    });
    syncBuiltinESMExports();

    const result = await rejectRunSnapshot(projectDir, sessionId);

    expect(changed).toBe(true);
    expect(result).toMatchObject({
      status: 'rejected',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: ['source'],
    });
    await expect(readFile(file, 'utf8')).resolves.toBe('later user edit');
  },
);

it('keeps a mode change made while the restored file is prepared', async () => {
  const file = join(projectDir, 'script');
  await writeFile(file, 'before');
  await chmod(file, 0o751);
  await createSnapshot({ projectDir, sessionId, phase: 'manual' });
  await writeFile(file, 'run bytes');
  await recordRun();
  const originalOpen = fs.open;
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (!changed && dirname(String(path)) === projectDir && String(path).includes('.tmp.')) {
      changed = true;
      await chmod(file, 0o700);
    }
    return handle;
  });
  syncBuiltinESMExports();

  expect(await rejectRunSnapshot(projectDir, sessionId)).toMatchObject({
    status: 'rejected',
    restoredPaths: [],
    conflictedPaths: ['script'],
  });
  expect(changed).toBe(true);
  expect((await stat(file)).mode & 0o777).toBe(0o700);
  await expect(readFile(file, 'utf8')).resolves.toBe('run bytes');
});
