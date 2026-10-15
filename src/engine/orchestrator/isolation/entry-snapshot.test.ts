import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { evidenceLedgerPath } from '../../../core/evidence/ledger-storage.js';
import {
  captureEntrySnapshot,
  captureWorkspaceSnapshot,
  entryStoreDir,
  restoreWorkspaceFiles,
} from './entry-snapshot.js';
import { withAttemptRestoreScope } from '../task/restore-scope.js';

const git = vi.hoisted(() => ({
  raw: vi.fn(),
  showBuffer: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
}));
vi.mock('simple-git', () => ({ simpleGit: () => git }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

it('restores saved bytes with one blob read and removes creations without creating a ledger', async () => {
  const ref = setupProject(directories);
  const dir = ref.projectDir;
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/kept.ts'), 'original\n');
  const store = entryStoreDir(ref);
  const snapshot = await captureEntrySnapshot(dir, { ignoreProjectDir: dir, store });
  writeFileSync(join(dir, 'src/kept.ts'), 'changed\n');
  writeFileSync(join(dir, 'src/new.ts'), 'created\n');
  vi.mocked(readFile).mockClear();

  const result = await restoreWorkspaceFiles({
    ref,
    dir,
    snapshot: { ...snapshot, restoreFiles: ['src/kept.ts', 'src/new.ts'] },
    files: ['src/kept.ts', 'src/new.ts'],
  });

  expect(result.restoredFiles).toEqual(['src/kept.ts', 'src/new.ts']);
  expect(readFileSync(join(dir, 'src/kept.ts'), 'utf8')).toBe('original\n');
  expect(existsSync(join(dir, 'src/new.ts'))).toBe(false);
  expect(existsSync(evidenceLedgerPath(ref))).toBe(false);
  const blob = join(store, snapshot.baselineFileHashes?.['src/kept.ts'] ?? 'missing');
  expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === blob)).toHaveLength(1);
});

it('restores each committed entry with one lookup and reads each saved blob once', async () => {
  const ref = setupProject(directories);
  const dir = ref.projectDir;
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/kept.ts'), 'changed\n');
  writeFileSync(join(dir, 'src/new.ts'), 'created\n');
  git.status.mockResolvedValue({ files: [{ path: 'src/kept.ts' }, { path: 'src/new.ts' }] });
  git.raw.mockImplementation(async (args: string[]) => {
    if (args[0] !== 'ls-tree') throw new Error(`Unexpected command: ${args.join(' ')}`);
    return args.at(-1) === ':(literal)src/kept.ts' ? '100644 blob abcdef\tsrc/kept.ts\0' : '';
  });
  git.showBuffer.mockResolvedValue(Buffer.from('original\n'));

  const result = await restoreWorkspaceFiles({
    ref,
    dir,
    snapshot: {
      head: 'saved-head',
      files: [],
      dirtyFileContents: {},
      restoreFiles: ['src/kept.ts', 'src/new.ts'],
    },
    files: ['src/kept.ts', 'src/new.ts'],
  });

  expect(result.restoredFiles).toEqual(['src/kept.ts', 'src/new.ts']);
  expect(readFileSync(join(dir, 'src/kept.ts'), 'utf8')).toBe('original\n');
  expect(existsSync(join(dir, 'src/new.ts'))).toBe(false);
  expect(git.raw.mock.calls.filter(([args]) => args[0] === 'ls-tree')).toEqual([
    [['ls-tree', '-z', 'saved-head', '--', ':(literal)src/kept.ts']],
    [['ls-tree', '-z', 'saved-head', '--', ':(literal)src/new.ts']],
  ]);
  expect(git.showBuffer.mock.calls).toEqual([[['abcdef']]]);
});

it('reverts only changed paths even when the request includes untouched user files', async () => {
  const ref = setupProject(directories);
  const dir = ref.projectDir;
  writeFileSync(join(dir, 'user.txt'), 'my uncommitted work\n');
  writeFileSync(join(dir, 'attempt.txt'), 'before\n');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(dir, 'user.txt'), timestamp, timestamp);
  const userStat = statSync(join(dir, 'user.txt'), { bigint: true });
  const snapshot = await captureEntrySnapshot(dir, {
    ignoreProjectDir: dir,
    store: entryStoreDir(ref),
  });
  writeFileSync(join(dir, 'attempt.txt'), 'failed attempt\n');

  const result = await restoreWorkspaceFiles({
    ref,
    dir,
    snapshot: { ...snapshot, restoreFiles: ['attempt.txt'] },
    files: ['user.txt', 'attempt.txt'],
  });

  expect(result.restoredFiles).toEqual(['attempt.txt']);
  expect(readFileSync(join(dir, 'attempt.txt'), 'utf8')).toBe('before\n');
  expect(readFileSync(join(dir, 'user.txt'), 'utf8')).toBe('my uncommitted work\n');
  expect(statSync(join(dir, 'user.txt'), { bigint: true }).mtimeNs).toBe(userStat.mtimeNs);
  if (result.savedTo === undefined) throw new Error('Missing revert backup');
  expect(readFileSync(join(result.savedTo, 'attempt.txt'), 'utf8')).toBe('failed attempt\n');
  expect(existsSync(join(result.savedTo, 'user.txt'))).toBe(false);
});

it.each([{ files: undefined }, { files: ['attempt.txt', 'user.txt'] }])(
  'enforces the recorded restore scope when the requested paths are $files',
  async ({ files }) => {
    const ref = setupProject(directories);
    const dir = ref.projectDir;
    writeFileSync(join(dir, 'user.txt'), 'before user edit\n');
    writeFileSync(join(dir, 'attempt.txt'), 'before attempt\n');
    const snapshot = await captureEntrySnapshot(dir, {
      ignoreProjectDir: dir,
      store: entryStoreDir(ref),
    });
    writeFileSync(join(dir, 'attempt.txt'), 'failed attempt\n');
    const scopedSnapshot = { ...snapshot, restoreFiles: ['attempt.txt'] };
    writeFileSync(join(dir, 'user.txt'), 'edited while halted\n');

    const result = await restoreWorkspaceFiles({ ref, dir, snapshot: scopedSnapshot, files });

    expect(result.restoredFiles).toEqual(['attempt.txt']);
    expect(readFileSync(join(dir, 'attempt.txt'), 'utf8')).toBe('before attempt\n');
    expect(readFileSync(join(dir, 'user.txt'), 'utf8')).toBe('edited while halted\n');
    if (result.savedTo === undefined) throw new Error('Missing revert backup');
    expect(existsSync(join(result.savedTo, 'user.txt'))).toBe(false);
  },
);

it('preserves every path when an older snapshot has no ownership evidence', async () => {
  const ref = setupProject(directories);
  const dir = ref.projectDir;
  writeFileSync(join(dir, 'user.txt'), 'before\n');
  const snapshot = await captureEntrySnapshot(dir, {
    ignoreProjectDir: dir,
    store: entryStoreDir(ref),
  });
  writeFileSync(join(dir, 'user.txt'), 'edited while halted\n');
  writeFileSync(join(dir, 'scratch.txt'), 'notes while halted\n');

  const result = await restoreWorkspaceFiles({
    ref,
    dir,
    snapshot,
    files: ['user.txt', 'scratch.txt'],
  });

  expect(result).toEqual({ restoredFiles: [] });
  expect(readFileSync(join(dir, 'user.txt'), 'utf8')).toBe('edited while halted\n');
  expect(readFileSync(join(dir, 'scratch.txt'), 'utf8')).toBe('notes while halted\n');
});

it.each(['notes.txt', 'notes/draft.txt'])(
  'preserves untouched %s when a failed attempt removes its ignore rule',
  async (notes) => {
    const ref = setupProject(directories);
    const dir = ref.projectDir;
    mkdirSync(join(dir, 'notes'));
    const ignore = `${notes}\n`;
    writeFileSync(join(dir, '.gitignore'), ignore);
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    writeFileSync(join(dir, notes), bytes);
    const timestamp = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(dir, notes), timestamp, timestamp);
    const before = statSync(join(dir, notes), { bigint: true });
    git.status.mockImplementation(async () => ({
      files:
        readFileSync(join(dir, '.gitignore'), 'utf8') === ignore
          ? []
          : [{ path: '.gitignore' }, { path: notes }],
    }));
    git.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse')
        return args.includes('--show-toplevel') ? `${dir}\nsaved-head\n` : 'saved-head\n';
      if (args[0] === 'ls-files')
        return args.includes('--ignored') &&
          readFileSync(join(dir, '.gitignore'), 'utf8') === ignore
          ? `${notes}\0`
          : '';
      if (args[0] === 'ls-tree')
        return args.at(-1) === ':(literal).gitignore' ? '100644 blob abcdef\t.gitignore\0' : '';
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    git.diff.mockResolvedValue('');
    git.showBuffer.mockResolvedValue(Buffer.from(ignore));
    const taskStartSnapshot = await captureWorkspaceSnapshot(dir, ref);
    const attemptSnapshot = await captureWorkspaceSnapshot(dir, ref);

    await expect(
      withAttemptRestoreScope({
        ref,
        dir,
        taskStartSnapshot,
        attemptSnapshot,
        run: async () => {
          writeFileSync(join(dir, '.gitignore'), '');
          throw new Error('Attempt failed');
        },
      }),
    ).rejects.toThrow('Attempt failed');
    const result = await restoreWorkspaceFiles({
      ref,
      dir,
      snapshot: attemptSnapshot,
      files: undefined,
    });

    expect(existsSync(join(dir, notes))).toBe(true);
    expect(readFileSync(join(dir, notes))).toEqual(bytes);
    expect(statSync(join(dir, notes), { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(ignore);
    expect(result.restoredFiles).toEqual(['.gitignore']);
    expect(taskStartSnapshot.restoreFiles).toEqual(['.gitignore']);
    expect(attemptSnapshot.restoreFiles).toEqual(['.gitignore']);
    if (result.savedTo === undefined) throw new Error('Missing revert backup');
    expect(existsSync(join(result.savedTo, notes))).toBe(false);
  },
);
