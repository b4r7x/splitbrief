import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotFilesDir, SNAPSHOT_BASELINE_ID, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createSnapshot } from '../../snapshots/create.js';
import { readManifest, writeManifest } from '../../snapshots/manifest.js';
import { encodeSnapshotPath } from '../../snapshots/path-codec.js';
import { writeRunPatch } from './patch.js';

const SESSION_ID = '2026-10-04-run-patch';
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

async function baseAndWorkspace(files: Record<string, string>, links: Record<string, string> = {}) {
  const projectDir = createTempDir('run-patch-');
  dirs.push(projectDir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(projectDir, path, '..'), { recursive: true });
    writeFileSync(join(projectDir, path), text);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(projectDir, path));
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
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(workspaceDir, path));
  return { ref, workspace: { path: workspaceDir, base: { snapshotId: base.manifest.id } } };
}

async function removeBaseMetadata(ref: SessionRef, snapshotId: string) {
  for (const id of [SNAPSHOT_BASELINE_ID, snapshotId]) {
    const manifest = await readManifest(ref.projectDir, ref.sessionId, id);
    delete manifest.symlinks;
    manifest.fileEntries = manifest.fileEntries.map(({ path, hash, encodedName }) => ({
      path,
      hash,
      encodedName,
    }));
    await writeManifest(ref.projectDir, ref.sessionId, manifest);
  }
}

describe('writeRunPatch', () => {
  it.each(['nested.txt', 'new-dir/nested.txt'])(
    'refuses writes through a captured symlink ancestor for %s',
    async (path) => {
      const { ref, workspace } = await baseAndWorkspace({ [`entry/${path}`]: 'snapshot\n' });
      const outside = createTempDir('run-patch-outside-');
      dirs.push(outside);
      writeFileSync(join(outside, 'nested.txt'), 'outside\n');
      const base = await readManifest(ref.projectDir, ref.sessionId, workspace.base.snapshotId);
      base.symlinks = [{ path: 'entry', target: outside }];
      await writeManifest(ref.projectDir, ref.sessionId, base);
      rmSync(join(workspace.path, 'entry'), { recursive: true });

      await expect(writeRunPatch(ref, workspace)).rejects.toThrow(/escapes root/);
      expect(readFileSync(join(outside, 'nested.txt'), 'utf8')).toBe('outside\n');
      expect(existsSync(join(outside, 'new-dir'))).toBe(false);
    },
  );

  it.each([0o755, 0o644])(
    'omits mode-only changes without a recorded base mode: %i',
    async (mode) => {
      const { ref, workspace } = await baseAndWorkspace({ 'script.sh': 'echo hello\n' });
      chmodSync(join(ref.projectDir, 'script.sh'), 0o755);
      chmodSync(join(workspace.path, 'script.sh'), mode);
      await removeBaseMetadata(ref, workspace.base.snapshotId);

      expect(await writeRunPatch(ref, workspace)).toBeNull();
    },
  );

  it('omits modes from an older delta even when its baseline records a mode', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'script.sh': 'echo hello\n' });
    chmodSync(join(ref.projectDir, 'script.sh'), 0o755);
    chmodSync(join(workspace.path, 'script.sh'), 0o755);
    const base = await readManifest(ref.projectDir, ref.sessionId, workspace.base.snapshotId);
    delete base.symlinks;
    await writeManifest(ref.projectDir, ref.sessionId, base);

    expect(await writeRunPatch(ref, workspace)).toBeNull();
  });

  it.each(['unchanged', 'created', 'removed', 'retargeted'] as const)(
    'omits symlink changes without recorded base symlinks: %s',
    async (change) => {
      const { ref, workspace } = await baseAndWorkspace(
        { target: 'target\n' },
        change === 'created' ? {} : { link: 'target' },
      );
      await removeBaseMetadata(ref, workspace.base.snapshotId);
      if (change === 'removed' || change === 'retargeted') rmSync(join(workspace.path, 'link'));
      if (change === 'created' || change === 'retargeted')
        symlinkSync('another-target', join(workspace.path, 'link'));

      expect(await writeRunPatch(ref, workspace)).toBeNull();
    },
  );

  it.each([0o755, 0o644])(
    'replays content changes from an older base with workspace mode %i',
    async (mode) => {
      const { ref, workspace } = await baseAndWorkspace(
        { 'script.sh': 'echo before\n' },
        { link: 'script.sh' },
      );
      chmodSync(join(ref.projectDir, 'script.sh'), 0o755);
      chmodSync(join(workspace.path, 'script.sh'), mode);
      await removeBaseMetadata(ref, workspace.base.snapshotId);
      writeFileSync(join(workspace.path, 'script.sh'), 'echo after\n');

      const patchPath = await writeRunPatch(ref, workspace);
      if (patchPath === null) throw new Error('the changed workspace has no patch');
      const patch = readFileSync(patchPath, 'utf8');
      expect(patch).toContain('script.sh');
      expect(patch).toMatch(new RegExp(`index [^\\n]+ 100${mode.toString(8)}`));
      expect(patch).not.toMatch(/old mode|new mode|diff --git a\/link /);
      execFileSync('git', ['apply', '--check', patchPath], { cwd: ref.projectDir });
      execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
      expect(readFileSync(join(ref.projectDir, 'script.sh'), 'utf8')).toBe('echo after\n');
      expect(statSync(join(ref.projectDir, 'script.sh')).mode & 0o777).toBe(0o755);
      expect(readlinkSync(join(ref.projectDir, 'link'))).toBe('script.sh');
    },
  );

  it.each([0o644, 0o755])(
    'replays an additions-only patch from an older manifest with workspace mode %i',
    async (mode) => {
      const { ref, workspace } = await baseAndWorkspace({ 'base.txt': 'base\n' });
      await removeBaseMetadata(ref, workspace.base.snapshotId);
      writeFileSync(join(workspace.path, 'new.txt'), 'created\n');
      chmodSync(join(workspace.path, 'new.txt'), mode);
      const replayDir = createTempDir('run-patch-older-replay-');
      dirs.push(replayDir);
      cpSync(ref.projectDir, replayDir, { recursive: true });

      const patchPath = await writeRunPatch(ref, workspace);
      if (patchPath === null) throw new Error('the changed workspace has no patch');
      const patch = readFileSync(patchPath, 'utf8');
      expect(patch).toContain('diff --git a/new.txt b/new.txt');
      expect(patch).toContain(`new file mode 100${mode.toString(8)}`);
      expect(patch).toContain('+created\n');
      expect(patch).not.toMatch(/old mode|\nnew mode/);
      execFileSync('git', ['apply', '--check', patchPath], { cwd: replayDir });
      execFileSync('git', ['apply', patchPath], { cwd: replayDir });
      expect(readFileSync(join(replayDir, 'new.txt'), 'utf8')).toBe('created\n');
      expect(statSync(join(replayDir, 'new.txt')).mode & 0o777).toBe(mode);
      expect(readFileSync(join(replayDir, 'base.txt'), 'utf8')).toBe('base\n');
    },
  );

  it('replays creations, edits and deletions from an older manifest after checkout changes', async () => {
    const { ref, workspace } = await baseAndWorkspace(
      { 'changed.txt': 'before\n', 'deleted.txt': 'deleted\n' },
      { link: 'changed.txt' },
    );
    await removeBaseMetadata(ref, workspace.base.snapshotId);
    const replayDir = createTempDir('run-patch-older-replay-');
    dirs.push(replayDir);
    cpSync(ref.projectDir, replayDir, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(workspace.path, 'new.txt'), 'created\n');
    writeFileSync(join(workspace.path, 'changed.txt'), 'after\n');
    chmodSync(join(workspace.path, 'changed.txt'), 0o755);
    rmSync(join(workspace.path, 'deleted.txt'));
    writeFileSync(join(ref.projectDir, 'changed.txt'), 'checkout edit\n');
    writeFileSync(join(ref.projectDir, 'new.txt'), 'checkout creation\n');
    rmSync(join(ref.projectDir, 'deleted.txt'));
    rmSync(join(ref.projectDir, 'link'));

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('diff --git a/new.txt b/new.txt');
    expect(patch).toContain('diff --git a/changed.txt b/changed.txt');
    expect(patch).toContain('diff --git a/deleted.txt b/deleted.txt');
    expect(patch).toContain('-before\n+after\n');
    expect(patch).toContain('-deleted\n');
    expect(patch).not.toMatch(/old mode|\nnew mode|120000|diff --git a\/link /);
    execFileSync('git', ['apply', '--check', patchPath], { cwd: replayDir });
    execFileSync('git', ['apply', patchPath], { cwd: replayDir });
    expect(readFileSync(join(replayDir, 'new.txt'), 'utf8')).toBe('created\n');
    expect(readFileSync(join(replayDir, 'changed.txt'), 'utf8')).toBe('after\n');
    expect(statSync(join(replayDir, 'changed.txt')).mode & 0o777).toBe(0o644);
    expect(existsSync(join(replayDir, 'deleted.txt'))).toBe(false);
    expect(readlinkSync(join(replayDir, 'link'))).toBe('changed.txt');
  });

  it.each(['file', 'directory'] as const)(
    'includes regular files replacing an unrecorded base symlink with a %s',
    async (kind) => {
      const { ref, workspace } = await baseAndWorkspace({ target: 'target\n' }, { link: 'target' });
      await removeBaseMetadata(ref, workspace.base.snapshotId);
      rmSync(join(workspace.path, 'link'));
      if (kind === 'directory') mkdirSync(join(workspace.path, 'link'));
      const path = kind === 'file' ? 'link' : 'link/file.txt';
      writeFileSync(join(workspace.path, path), 'replacement\n');
      rmSync(join(ref.projectDir, 'link'));

      const patchPath = await writeRunPatch(ref, workspace);
      if (patchPath === null) throw new Error('the changed workspace has no patch');
      const patch = readFileSync(patchPath, 'utf8');
      expect(patch).toContain(`diff --git a/${path} b/${path}\nnew file mode 100644`);
      expect(patch).toContain('+replacement\n');
      expect(patch).not.toMatch(/120000|deleted file mode/);
    },
  );

  it('refuses an older regular file replaced by a symlink to different contents', async () => {
    const { ref, workspace } = await baseAndWorkspace({ file: 'before\n', target: 'different\n' });
    await removeBaseMetadata(ref, workspace.base.snapshotId);
    rmSync(join(workspace.path, 'file'));
    symlinkSync('target', join(workspace.path, 'file'));

    await expect(writeRunPatch(ref, workspace)).rejects.toThrow(/symlink/);
  });

  it('refuses an older directory replaced by a regular file', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'dir/file.txt': 'before\n' });
    await removeBaseMetadata(ref, workspace.base.snapshotId);
    rmSync(join(workspace.path, 'dir'), { recursive: true });
    writeFileSync(join(workspace.path, 'dir'), 'replacement\n');

    await expect(writeRunPatch(ref, workspace)).rejects.toThrow(/ENOTDIR/);
  });

  it('does not need a stored blob for an unchanged file', async () => {
    const { ref, workspace } = await baseAndWorkspace({ unchanged: 'same\n', changed: 'before\n' });
    rmSync(join(snapshotFilesDir(ref, SNAPSHOT_BASELINE_ID), encodeSnapshotPath('unchanged')));
    writeFileSync(join(workspace.path, 'changed'), 'after\n');

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    expect(readFileSync(patchPath, 'utf8')).not.toContain('unchanged');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    expect(readFileSync(join(ref.projectDir, 'changed'), 'utf8')).toBe('after\n');
  });

  it('omits a new .gitignore that contains only isolation bookkeeping', async () => {
    const { ref, workspace } = await baseAndWorkspace({});
    writeFileSync(join(workspace.path, '.gitignore'), '.splitbrief/\n.trees/\n');

    expect(await writeRunPatch(ref, workspace)).toBeNull();
  });

  it('treats a regular file named constructor as a file', async () => {
    const { ref, workspace } = await baseAndWorkspace({ constructor: 'before\n' });
    writeFileSync(join(workspace.path, 'constructor'), 'after\n');

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    expect(readFileSync(join(ref.projectDir, 'constructor'), 'utf8')).toBe('after\n');
  });

  it.each(['constructor', '__proto__'])('replays a retargeted symlink named %s', async (path) => {
    const { ref, workspace } = await baseAndWorkspace({}, Object.fromEntries([[path, 'before']]));
    rmSync(join(workspace.path, path));
    symlinkSync('after', join(workspace.path, path));

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    expect(readlinkSync(join(ref.projectDir, path))).toBe('after');
  });

  it('replays a mode-only change with independent base and workspace modes', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'script.sh': 'echo hello\n' });
    chmodSync(join(workspace.path, 'script.sh'), 0o755);

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    const patch = readFileSync(patchPath, 'utf8');
    expect(patch).toContain('old mode 100644\nnew mode 100755');
    expect(patch).not.toContain('@@');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    expect(statSync(join(ref.projectDir, 'script.sh')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(ref.projectDir, 'script.sh'), 'utf8')).toBe('echo hello\n');
  });

  it('replays deletion of a symlink whose parent directory was removed', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'nested/kept.txt': 'base\n' });
    symlinkSync('missing', join(ref.projectDir, 'nested/link'));
    const base = await createSnapshot({ ...ref, phase: 'manual' });
    workspace.base.snapshotId = base.manifest.id;
    rmSync(join(workspace.path, 'nested'), { recursive: true });

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    expect(existsSync(join(ref.projectDir, 'nested'))).toBe(false);
  });

  it.each(['created', 'removed', 'retargeted'] as const)('replays a %s symlink', async (change) => {
    const { ref, workspace } = await baseAndWorkspace(
      {},
      change === 'created' ? {} : { link: 'missing-before' },
    );
    if (change !== 'created') rmSync(join(workspace.path, 'link'));
    if (change !== 'removed') symlinkSync('missing-after', join(workspace.path, 'link'));

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');
    expect(readFileSync(patchPath, 'utf8')).toContain('120000');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    if (change === 'removed') {
      expect(() => readlinkSync(join(ref.projectDir, 'link'))).toThrow();
    } else {
      expect(readlinkSync(join(ref.projectDir, 'link'))).toBe('missing-after');
    }
  });

  it('reads the base mode from a delta snapshot with unchanged bytes', async () => {
    const { ref, workspace } = await baseAndWorkspace({ 'script.sh': 'echo hello\n' });
    chmodSync(join(ref.projectDir, 'script.sh'), 0o755);
    const base = await createSnapshot({ ...ref, phase: 'manual' });
    workspace.base.snapshotId = base.manifest.id;

    const patchPath = await writeRunPatch(ref, workspace);
    if (patchPath === null) throw new Error('the changed workspace has no patch');

    expect(readFileSync(patchPath, 'utf8')).toContain('old mode 100755\nnew mode 100644');
    execFileSync('git', ['apply', patchPath], { cwd: ref.projectDir });
    expect(statSync(join(ref.projectDir, 'script.sh')).mode & 0o777).toBe(0o644);
  });

  it.each(['file', 'symlink'] as const)(
    'replays a %s replaced by the other entry kind',
    async (kind) => {
      const { ref, workspace } = await baseAndWorkspace(
        kind === 'file' ? { entry: 'same-text' } : {},
        kind === 'symlink' ? { entry: 'same-text' } : {},
      );
      rmSync(join(workspace.path, 'entry'));
      if (kind === 'file') symlinkSync('same-text', join(workspace.path, 'entry'));
      else writeFileSync(join(workspace.path, 'entry'), 'same-text');
      const replayDir = createTempDir('run-patch-kind-replay-');
      dirs.push(replayDir);
      cpSync(ref.projectDir, replayDir, { recursive: true, verbatimSymlinks: true });

      const patchPath = await writeRunPatch(ref, workspace);
      if (patchPath === null) throw new Error('the changed workspace has no patch');
      execFileSync('git', ['apply', '--check', patchPath], { cwd: replayDir });
      execFileSync('git', ['apply', patchPath], { cwd: replayDir });

      if (kind === 'file') expect(readlinkSync(join(replayDir, 'entry'))).toBe('same-text');
      else expect(readFileSync(join(replayDir, 'entry'), 'utf8')).toBe('same-text');
    },
  );

  it.each(['symlink', 'directory'] as const)(
    'replays replacements between a symlink and directory, starting with a %s',
    async (kind) => {
      const { ref, workspace } = await baseAndWorkspace(
        {
          'target/file.txt': 'target\n',
          ...(kind === 'directory' ? { 'dir/file.txt': 'before\n' } : {}),
        },
        kind === 'symlink' ? { dir: 'target' } : {},
      );
      rmSync(join(workspace.path, 'dir'), { recursive: true });
      if (kind === 'symlink') {
        mkdirSync(join(workspace.path, 'dir'));
        writeFileSync(join(workspace.path, 'dir/file.txt'), 'after\n');
      } else {
        symlinkSync('target', join(workspace.path, 'dir'));
      }
      const replayDir = createTempDir('run-patch-directory-replay-');
      dirs.push(replayDir);
      cpSync(ref.projectDir, replayDir, { recursive: true, verbatimSymlinks: true });

      const patchPath = await writeRunPatch(ref, workspace);
      if (patchPath === null) throw new Error('the changed workspace has no patch');
      const patch = readFileSync(patchPath, 'utf8');
      expect(patch).toContain('120000');
      expect(patch).toContain('diff --git a/dir/file.txt b/dir/file.txt');
      expect(patch).toContain(
        kind === 'symlink' ? 'deleted file mode 120000' : 'new file mode 120000',
      );
      execFileSync('git', ['apply', '--check', patchPath], { cwd: replayDir });
      execFileSync('git', ['apply', patchPath], { cwd: replayDir });
      expect(readFileSync(join(replayDir, 'target/file.txt'), 'utf8')).toBe('target\n');
      if (kind === 'symlink') {
        expect(readFileSync(join(replayDir, 'dir/file.txt'), 'utf8')).toBe('after\n');
      } else {
        expect(readlinkSync(join(replayDir, 'dir'))).toBe('target');
      }
    },
  );

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
