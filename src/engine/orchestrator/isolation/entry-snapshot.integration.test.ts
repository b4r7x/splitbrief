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
import { simpleGit } from 'simple-git';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { recordApiApplyEvidence, recordedApiCreatedPaths } from '../evidence/task.js';
import {
  captureWorkspaceSnapshot,
  entryStoreDir,
  restoreWorkspaceFiles,
} from './entry-snapshot.js';

import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { withAttemptRestoreScope } from '../task/restore-scope.js';

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

    await restoreWorkspaceFiles({
      ref,
      dir,
      snapshot: { ...snapshot, restoreFiles: changed },
      files: changed,
    });

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
  it('preserves an ignored directory when the attempt only changes its visibility', async () => {
    const dir = project();
    await simpleGit(dir).init();
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, '.gitignore'), 'notes/\n');
    writeFileSync(join(dir, 'notes', 'draft.txt'), 'user work\n');
    const ref = { projectDir: dir, sessionId: SESSION };
    const snapshot = await captureWorkspaceSnapshot(dir, ref);

    await expect(
      withAttemptRestoreScope({
        ref,
        dir,
        taskStartSnapshot: snapshot,
        run: async () => {
          writeFileSync(join(dir, '.gitignore'), '');
          throw new Error('Attempt failed');
        },
      }),
    ).rejects.toThrow('Attempt failed');
    const result = await restoreWorkspaceFiles({ ref, dir, snapshot, files: undefined });

    expect(existsSync(join(dir, 'notes', 'draft.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'notes', 'draft.txt'), 'utf8')).toBe('user work\n');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('notes/\n');
    expect(result.restoredFiles).toEqual(['.gitignore']);
    if (result.savedTo === undefined) throw new Error('Missing revert backup');
    expect(existsSync(join(result.savedTo, 'notes'))).toBe(false);
  });

  it.each(['staged', 'committed'] as const)(
    'restores both endpoints of a %s rename and preserves unrelated dirty files',
    async (kind) => {
      const dir = project();
      createTestGitRepo(dir, { 'old.ts': 'original\n', 'user.txt': 'committed\n' });
      writeFileSync(join(dir, 'user.txt'), 'user edit\n');
      writeFileSync(join(dir, 'scratch.txt'), 'user notes\n');
      const ref = { projectDir: dir, sessionId: SESSION };
      const snapshot = await captureWorkspaceSnapshot(dir, ref);

      createTestGitRepo(dir, { 'new.ts': 'original\n', 'user.txt': 'committed\n' });
      rmSync(join(dir, 'old.ts'));
      if (kind === 'staged') {
        writeFileSync(join(dir, '.git/refs/heads/main'), `${snapshot.head}\n`);
      }
      writeFileSync(join(dir, 'user.txt'), 'user edit\n');

      const result = await restoreWorkspaceFiles({
        ref,
        dir,
        snapshot: { ...snapshot, restoreFiles: ['old.ts', 'new.ts'] },
        files: ['old.ts', 'new.ts', 'user.txt', 'scratch.txt'],
      });

      expect(result.restoredFiles).toEqual(['new.ts', 'old.ts']);
      expect(readFileSync(join(dir, 'old.ts'), 'utf8')).toBe('original\n');
      expect(existsSync(join(dir, 'new.ts'))).toBe(false);
      expect(readFileSync(join(dir, 'user.txt'), 'utf8')).toBe('user edit\n');
      expect(readFileSync(join(dir, 'scratch.txt'), 'utf8')).toBe('user notes\n');
      if (result.savedTo === undefined) throw new Error('Missing revert backup');
      expect(readdirSync(result.savedTo)).toEqual(['new.ts']);
    },
  );

  it('leaves unrelated tracked and untracked user edits out of a requested revert', async () => {
    const dir = project();
    createTestGitRepo(dir, { 'user.txt': 'committed\n', 'attempt.txt': 'before\n' });
    writeFileSync(join(dir, 'user.txt'), 'user edit\n');
    writeFileSync(join(dir, 'scratch.txt'), 'user notes\n');
    const ref = { projectDir: dir, sessionId: SESSION };
    const snapshot = await captureWorkspaceSnapshot(dir, ref);
    writeFileSync(join(dir, 'attempt.txt'), 'failed attempt\n');
    writeFileSync(join(dir, 'created.txt'), 'attempt creation\n');

    const result = await restoreWorkspaceFiles({
      ref,
      dir,
      snapshot: { ...snapshot, restoreFiles: ['attempt.txt', 'created.txt'] },
      files: ['user.txt', 'scratch.txt', 'attempt.txt', 'created.txt'],
    });

    expect(result.restoredFiles).toEqual(['attempt.txt', 'created.txt']);
    expect(readFileSync(join(dir, 'attempt.txt'), 'utf8')).toBe('before\n');
    expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'user.txt'), 'utf8')).toBe('user edit\n');
    expect(readFileSync(join(dir, 'scratch.txt'), 'utf8')).toBe('user notes\n');
    if (result.savedTo === undefined) throw new Error('Missing revert backup');
    expect(readdirSync(result.savedTo).sort()).toEqual(['attempt.txt', 'created.txt']);
  });

  it.each(['git', 'entries'] as const)(
    'reconciles creation proof against the %s snapshot and only the restored paths',
    async (kind) => {
      const dir = project();
      if (kind === 'git') createTestGitRepo(dir);
      const ref = { projectDir: dir, sessionId: SESSION };
      const task = makeTask({
        action: 'create',
        suggestedFiles: ['src/old.ts', 'src/new.ts', 'src/kept.ts'],
      });
      let ledger = createEvidenceLedger({ sessionId: SESSION, feature: 'feat', tasks: [task] });
      const create = (path: string) => {
        writeFileSync(join(dir, path), 'created\n');
        ledger = recordApiApplyEvidence({
          ledger,
          task,
          workspacePath: dir,
          result: {
            callId: path,
            status: 'applied',
            candidatePaths: [path],
            applied: [
              {
                path,
                action: 'create',
                beforeSha256: null,
                afterSha256: 'a1',
                diff: '',
                linesAdded: 1,
                linesRemoved: 0,
              },
            ],
            noops: [],
            untouched: [],
          },
        });
        writeEvidenceLedger(ref, ledger);
      };
      create('src/old.ts');
      const snapshot = await captureWorkspaceSnapshot(dir, ref);
      writeFileSync(join(dir, 'src/old.ts'), 'corrected\n');
      create('src/new.ts');
      create('src/kept.ts');

      await restoreWorkspaceFiles({
        ref,
        dir,
        snapshot: { ...snapshot, restoreFiles: ['src/old.ts', 'src/new.ts'] },
        files: ['src/old.ts', 'src/new.ts'],
      });

      expect(readFileSync(join(dir, 'src/old.ts'), 'utf8')).toBe('created\n');
      expect(existsSync(join(dir, 'src/new.ts'))).toBe(false);
      expect(readFileSync(join(dir, 'src/kept.ts'), 'utf8')).toBe('created\n');
      expect(recordedApiCreatedPaths(ref, task, dir)).toEqual(['src/old.ts', 'src/kept.ts']);
      expect(readEvidenceLedger(ref)?.tasks[0]?.apiApply?.revertedPaths).toEqual(['src/new.ts']);
    },
  );

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
      snapshot: {
        ...snapshot,
        restoreFiles: ['src/a.ts', 'src/bin.dat', 'src/created.ts', 'src/link.ts'],
      },
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
      snapshot: { ...snapshot, restoreFiles: ['a.ts'] },
      files: ['a.ts'],
    });

    expect(result.savedTo).toBeUndefined();
    expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe('one\n');
  });
});
