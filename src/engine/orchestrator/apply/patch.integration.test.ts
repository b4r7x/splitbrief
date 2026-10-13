import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createSnapshot } from '../../snapshots/create.js';
import { writeRunPatch } from './patch.js';

const SESSION_ID = '2026-10-04-run-patch';
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

async function baseAndWorkspace(files: Record<string, string>) {
  const projectDir = createTempDir('run-patch-');
  dirs.push(projectDir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(projectDir, path, '..'), { recursive: true });
    writeFileSync(join(projectDir, path), text);
  }
  const ref = { projectDir, sessionId: SESSION_ID };
  ensureSessionDir(projectDir, SESSION_ID);
  await createSnapshot({ ...ref, phase: 'manual', name: 'run-baseline' });
  const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
  const workspaceDir = createTempDir('run-patch-workspace-');
  dirs.push(workspaceDir);
  for (const path of Object.keys(files)) {
    mkdirSync(join(workspaceDir, path, '..'), { recursive: true });
    cpSync(join(projectDir, path), join(workspaceDir, path));
  }
  return { ref, workspace: { path: workspaceDir, base: { snapshotId: base.manifest.id } } };
}

describe('writeRunPatch', () => {
  it('replays an additions-only patch onto the base files', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'src/base.txt': 'base\n' });
    const newBytes = Buffer.from([0, 1, 2, 255, 10]);
    writeFileSync(join(workspace.path, 'src/new.bin'), newBytes);
    const replayDir = createTempDir('run-patch-addition-replay-');
    dirs.push(replayDir);
    cpSync(join(ref.projectDir, 'src'), join(replayDir, 'src'), { recursive: true });

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');

    expect(readFileSync(patchPath, 'utf8')).not.toBe('');
    execFileSync('git', ['apply', patchPath], { cwd: replayDir });
    expect(readFileSync(join(replayDir, 'src/new.bin'))).toEqual(newBytes);
    expect(readFileSync(join(replayDir, 'src/base.txt'))).toEqual(
      readFileSync(join(workspace.path, 'src/base.txt')),
    );
  });

  it('replays a deletions-only patch onto the base files', async () => {
    const { ref, workspace } = await baseAndWorkspace({
      'src/deleted.txt': 'deleted\n',
      'src/kept.txt': 'kept\n',
    });
    rmSync(join(workspace.path, 'src/deleted.txt'));
    const replayDir = createTempDir('run-patch-deletion-replay-');
    dirs.push(replayDir);
    cpSync(join(ref.projectDir, 'src'), join(replayDir, 'src'), { recursive: true });

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');

    expect(readFileSync(patchPath, 'utf8')).not.toBe('');
    execFileSync('git', ['apply', patchPath], { cwd: replayDir });
    expect(existsSync(join(replayDir, 'src/deleted.txt'))).toBe(false);
    expect(readFileSync(join(replayDir, 'src/kept.txt'))).toEqual(
      readFileSync(join(workspace.path, 'src/kept.txt')),
    );
  });

  it('names both sides a/ and b/ for a created, a deleted and a modified file', async () => {
    const { ref, workspace } = await baseAndWorkspace({
      'src/changed.txt': 'before\n',
      'src/deleted.txt': 'deleted\n',
    });
    writeFileSync(join(workspace.path, 'src/changed.txt'), 'after\n');
    rmSync(join(workspace.path, 'src/deleted.txt'));
    writeFileSync(join(workspace.path, 'src/created.txt'), 'created\n');
    writeFileSync(join(workspace.path, 'src/zażółć.txt'), 'quoted\n');
    const replayDir = createTempDir('run-patch-sides-replay-');
    dirs.push(replayDir);
    cpSync(join(ref.projectDir, 'src'), join(replayDir, 'src'), { recursive: true });

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');

    const headers = readFileSync(patchPath, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('diff --git '));
    expect(headers.slice(0, 3)).toEqual([
      'diff --git a/src/changed.txt b/src/changed.txt',
      'diff --git a/src/created.txt b/src/created.txt',
      'diff --git a/src/deleted.txt b/src/deleted.txt',
    ]);
    expect(headers[3]).toMatch(/^diff --git "a\/src\/za\\\d{3}.*" "b\/src\/za\\\d{3}.*"$/);
    execFileSync('git', ['apply', '--check', patchPath], { cwd: replayDir });
  });

  it('refuses to write a patch when a new workspace file is unreadable', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'src/base.txt': 'base\n' });
    const unreadablePath = join(workspace.path, 'unreadable.txt');
    writeFileSync(unreadablePath, 'hidden\n');
    chmodSync(unreadablePath, 0o000);

    try {
      await expect(writeRunPatch(ref, workspace)).rejects.toThrow(/unreadable\.txt/);
    } finally {
      chmodSync(unreadablePath, 0o644);
    }
  });

  it('leaves out the bookkeeping lines isolation adds to .gitignore', async () => {
    const { ref, workspace } = await baseAndWorkspace({
      '.gitignore': 'dist/\n',
      'src/a.ts': 'a\n',
    });
    writeFileSync(join(workspace.path, '.gitignore'), `dist/\n${SPLITBRIEF_DIR}/\n.trees/\n`);
    writeFileSync(join(workspace.path, 'src/a.ts'), 'b\n');

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    const patch = readFileSync(patchPath, 'utf8');

    expect(patch).toContain('src/a.ts');
    expect(patch).not.toContain('.gitignore');
  });

  it('refuses to write a patch over a file whose base bytes were never captured', async () => {
    const { ref, workspace } = await (async () => {
      const projectDir = createTempDir('run-patch-unreadable-');
      dirs.push(projectDir);
      writeFileSync(join(projectDir, 'secret.txt'), 'hidden\n');
      chmodSync(join(projectDir, 'secret.txt'), 0o000);
      const sessionRef = { projectDir, sessionId: SESSION_ID };
      ensureSessionDir(projectDir, SESSION_ID);
      await createSnapshot({ ...sessionRef, phase: 'manual', name: 'run-baseline' });
      const base = await createSnapshot({ ...sessionRef, phase: 'manual', name: 'workspace-base' });
      chmodSync(join(projectDir, 'secret.txt'), 0o644);
      const workspaceDir = createTempDir('run-patch-unreadable-workspace-');
      dirs.push(workspaceDir);
      writeFileSync(join(workspaceDir, 'secret.txt'), 'changed\n');
      return {
        ref: sessionRef,
        workspace: { path: workspaceDir, base: { snapshotId: base.manifest.id } },
      };
    })();

    await expect(writeRunPatch(ref, workspace)).rejects.toThrow(/secret\.txt/);
  });
});
