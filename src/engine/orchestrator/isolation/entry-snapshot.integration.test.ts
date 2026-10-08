import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import {
  captureWorkspaceSnapshot,
  entryStoreDir,
  restoreWorkspaceFiles,
} from './entry-snapshot.js';

import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';

const SESSION = 's1';
const BINARY = Buffer.from([0, 1, 2, 255, 0, 7]);
let dirs: string[] = [];

function project(): string {
  const dir = createTempDir('entry-snapshot-');
  dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'bin.dat'), BINARY);
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('entry snapshots of a directory git does not describe', () => {
  it('records every entry without git and puts edits, creations, deletions and modes back', async () => {
    const dir = project();
    const ref = { projectDir: dir, sessionId: SESSION };
    const snapshot = await captureWorkspaceSnapshot(dir, ref);
    expect(snapshot.baselineFileHashes).toBeDefined();

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    rmSync(join(dir, 'src', 'bin.dat'));
    writeFileSync(join(dir, 'src', 'new.ts'), 'export {};\n');
    chmodSync(join(dir, 'run.sh'), 0o644);

    const changed = await getChangedFilesSinceSnapshot(dir, snapshot);
    expect(changed).toEqual(['run.sh', 'src/a.ts', 'src/bin.dat', 'src/new.ts']);

    await restoreWorkspaceFiles({ ref, dir, snapshot, files: changed });

    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(readFileSync(join(dir, 'src', 'bin.dat'))).toEqual(BINARY);
    expect(existsSync(join(dir, 'src', 'new.ts'))).toBe(false);
    expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual([]);
  });

  it('stores each content once, so a second snapshot of the same tree adds nothing', async () => {
    const dir = project();
    const ref = { projectDir: dir, sessionId: SESSION };
    await captureWorkspaceSnapshot(dir, ref);
    const stored = readdirSync(entryStoreDir(ref)).length;
    await captureWorkspaceSnapshot(dir, ref);
    expect(readdirSync(entryStoreDir(ref))).toHaveLength(stored);
  });

  it('takes the git snapshot where git describes the directory', async () => {
    const dir = createTempDir('entry-snapshot-git-');
    dirs.push(dir);
    createTestGitRepo(dir);
    const snapshot = await captureWorkspaceSnapshot(dir, { projectDir: dir, sessionId: SESSION });
    expect(snapshot.baselineFileHashes).toBeUndefined();
  });
});

describe('a revert in the checkout itself', () => {
  it('saves the bytes it replaces first, byte for byte, and a link as a link', async () => {
    const dir = project();
    const ref = { projectDir: dir, sessionId: SESSION };
    const snapshot = await captureWorkspaceSnapshot(dir, ref);
    writeFileSync(join(dir, 'src', 'a.ts'), 'implementer bytes\n');
    writeFileSync(join(dir, 'src', 'bin.dat'), Buffer.from([9, 9, 0, 9]));
    writeFileSync(join(dir, 'src', 'created.ts'), 'created\n');
    symlinkSync('a.ts', join(dir, 'src', 'link.ts'));

    const result = await restoreWorkspaceFiles({
      ref,
      dir,
      snapshot,
      files: ['src/a.ts', 'src/bin.dat', 'src/created.ts', 'src/link.ts'],
    });

    const saved = result.savedTo ?? '';
    expect(saved.startsWith(join(sessionDir(dir, SESSION), 'reverted'))).toBe(true);
    expect(readFileSync(join(saved, 'src', 'a.ts'), 'utf8')).toBe('implementer bytes\n');
    expect(readFileSync(join(saved, 'src', 'bin.dat'))).toEqual(Buffer.from([9, 9, 0, 9]));
    expect(readFileSync(join(saved, 'src', 'created.ts'), 'utf8')).toBe('created\n');
    expect(lstatSync(join(saved, 'src', 'link.ts')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(saved, 'src', 'link.ts'))).toBe('a.ts');
    expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(join(dir, 'src', 'created.ts'))).toBe(false);
    expect(existsSync(join(dir, 'src', 'link.ts'))).toBe(false);
  });

  it('saves nothing for a revert in a workspace that is not the checkout', async () => {
    const dir = project();
    const workspace = join(dir, '.splitbrief', 'sessions', SESSION, 'stage-1', 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'a.ts'), 'one\n');
    const ref = { projectDir: dir, sessionId: SESSION };
    const snapshot = await captureWorkspaceSnapshot(workspace, ref);
    writeFileSync(join(workspace, 'a.ts'), 'two\n');

    const result = await restoreWorkspaceFiles({
      ref,
      dir: workspace,
      snapshot,
      files: ['a.ts'],
    });

    expect(result.savedTo).toBeUndefined();
    expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe('one\n');
  });
});
