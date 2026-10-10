import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { evidenceLedgerPath } from '../../../core/evidence/ledger-storage.js';
import { captureEntrySnapshot, entryStoreDir, restoreWorkspaceFiles } from './entry-snapshot.js';

const git = vi.hoisted(() => ({ raw: vi.fn(), showBuffer: vi.fn() }));
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
    snapshot,
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
  git.raw.mockImplementation(async (args: string[]) => {
    if (args[0] !== 'ls-tree') throw new Error(`Unexpected command: ${args.join(' ')}`);
    return args.at(-1) === ':(literal)src/kept.ts' ? '100644 blob abcdef\tsrc/kept.ts\0' : '';
  });
  git.showBuffer.mockResolvedValue(Buffer.from('original\n'));

  const result = await restoreWorkspaceFiles({
    ref,
    dir,
    snapshot: { head: 'saved-head', files: [], dirtyFileContents: {} },
    files: ['src/kept.ts', 'src/new.ts'],
  });

  expect(result.restoredFiles).toEqual(['src/kept.ts', 'src/new.ts']);
  expect(readFileSync(join(dir, 'src/kept.ts'), 'utf8')).toBe('original\n');
  expect(existsSync(join(dir, 'src/new.ts'))).toBe(false);
  expect(git.raw.mock.calls).toEqual([
    [['ls-tree', '-z', 'saved-head', '--', ':(literal)src/kept.ts']],
    [['ls-tree', '-z', 'saved-head', '--', ':(literal)src/new.ts']],
  ]);
  expect(git.showBuffer.mock.calls).toEqual([[['abcdef']]]);
});
