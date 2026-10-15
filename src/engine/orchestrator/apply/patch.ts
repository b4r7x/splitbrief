import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isInternalGitStatusPath,
  RUN_PATCH_FILE,
  sessionDir,
  SNAPSHOT_BASELINE_ID,
} from '../../../core/paths.js';
import type { SnapshotFileEntry, SnapshotManifest } from '../../../core/schemas/snapshot.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { gitBinary } from '../../../lib/git/client.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
} from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { resolveValidatedBlobPath } from '../../snapshots/blob-resolver.js';
import { collectTrackedFiles, hashFile } from '../../snapshots/files.js';
import { readManifest } from '../../snapshots/manifest.js';
import { readConfinedEntry } from '../approval/file-snapshots/entry.js';
import { stripGitignoreBookkeeping } from '../approval/staged-project.js';
import { listWorkspaceEntries } from '../isolation/entry-snapshot.js';

type WorkspaceBase = { path: string; base: { snapshotId: string } };

type PatchEntry =
  | { kind: 'absent' }
  | { kind: 'file'; bytes: Buffer; sha256: string; mode: number | undefined }
  | { kind: 'symlink'; target: string };

type ChangedPath = {
  path: string;
  base: PatchEntry;
  ours: PatchEntry;
};

type ManifestIndex = {
  fileHashes: SnapshotManifest['fileHashes'];
  entries: Map<string, SnapshotFileEntry>;
  /** Undefined for a manifest written before symlinks and base modes were recorded. */
  symlinks: Map<string, string> | undefined;
};

function indexManifest(manifest: SnapshotManifest): ManifestIndex {
  return {
    fileHashes: manifest.fileHashes,
    entries: new Map(manifest.fileEntries.map((entry) => [entry.path, entry])),
    symlinks:
      manifest.symlinks === undefined
        ? undefined
        : new Map(manifest.symlinks.map((entry) => [entry.path, entry.target])),
  };
}

async function readBaseEntry(input: {
  ref: SessionRef;
  snapshotId: string;
  path: string;
  base: ManifestIndex;
  baseline: ManifestIndex;
  ours: PatchEntry;
}): Promise<PatchEntry> {
  const { ref, snapshotId, path, base, baseline, ours } = input;
  const target = base.symlinks?.get(path);
  if (target !== undefined) return { kind: 'symlink', target };
  const baseHash = Object.hasOwn(base.fileHashes, path) ? base.fileHashes[path] : undefined;
  if (baseHash === undefined) return { kind: 'absent' };
  const entry = base.entries.get(path);
  const inherited = entry === undefined && baseline.fileHashes[path] === baseHash;
  const resolvedEntry = inherited ? baseline.entries.get(path) : entry;
  const mode = base.symlinks === undefined ? undefined : resolvedEntry?.mode;
  if (
    ours.kind === 'file' &&
    ours.sha256 === baseHash &&
    (mode === undefined || ours.mode === mode)
  )
    return ours;
  const blobPath = await resolveValidatedBlobPath({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    snapshotId: inherited ? SNAPSHOT_BASELINE_ID : snapshotId,
    path,
    entry: resolvedEntry,
  });
  if (baseHash === '' || resolvedEntry?.hash !== baseHash || blobPath === null) {
    throw error(
      'run-patch-base-unavailable',
      `Cannot write the run patch: base contents for ${path} were not captured.`,
      { path },
    );
  }
  return {
    kind: 'file',
    bytes: await readFile(blobPath),
    sha256: baseHash,
    mode,
  };
}

function runGitDiff(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      gitBinary(),
      [
        'diff',
        '--no-index',
        '--binary',
        '--no-prefix',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--',
        'a',
        'b',
      ],
      { cwd: root },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        reject(
          error(
            'run-patch-diff-failed',
            `Cannot write the run patch: git diff exited with code ${code}.`,
            { code, stderr: Buffer.concat(stderr).toString('utf8') },
          ),
        );
        return;
      }
      resolve(withStandardSides(Buffer.concat(stdout).toString('utf8')));
    });
  });
}

/**
 * `git diff --no-index` names a file that one side lacks after the side that holds it: `b/x b/x`
 * for a created file, `a/x a/x` for a deleted one. A patch names its sides `a/` and `b/`, the way
 * git writes them for a commit; a quoted path keeps its quotes.
 */
function withStandardSides(diff: string): string {
  return diff.replace(/^diff --git ("?)[ab]\/(.*) \1[ab]\/\2$/gm, 'diff --git $1a/$2 $1b/$2');
}

/**
 * The changes the run's workspace holds over its base, as an apply-able patch.
 * The base blob is the only source of the a-side, so a path whose base bytes
 * were never captured fails the write instead of producing a hunk that would
 * create or delete content the operator never had.
 */
export async function writeRunPatch(
  ref: SessionRef,
  workspace: WorkspaceBase,
): Promise<string | null> {
  const { projectDir, sessionId } = ref;
  const base = indexManifest(await readManifest(projectDir, sessionId, workspace.base.snapshotId));
  const baseline = indexManifest(await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID));
  const tracked = new Set(
    base.symlinks === undefined
      ? await collectTrackedFiles(workspace.path, { ignoreProjectDir: projectDir })
      : await listWorkspaceEntries(workspace.path, projectDir),
  );
  const paths = [
    ...new Set([...Object.keys(base.fileHashes), ...(base.symlinks?.keys() ?? []), ...tracked]),
  ]
    .filter((path) => !isInternalGitStatusPath(path))
    .sort();

  const changes: ChangedPath[] = [];
  for (const path of paths) {
    assertPathConfined(path, workspace.path);
    const parents: string[] = [];
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      parents.push(parent);
    }
    const stat =
      base.symlinks !== undefined && parents.some((parent) => tracked.has(parent))
        ? null
        : await lstat(join(workspace.path, path)).catch((err: unknown) => {
            if (isENOENT(err)) return null;
            throw err;
          });
    if (base.symlinks === undefined) {
      const hash = await hashFile(join(workspace.path, path));
      if (hash === null && stat !== null) {
        throw error(
          'run-patch-workspace-unreadable',
          `Cannot write the run patch: workspace contents for ${path} could not be read.`,
          { path },
        );
      }
      if (hash === base.fileHashes[path]) continue;
    }
    let ours: PatchEntry;
    if (stat === null || stat.isDirectory()) {
      ours = { kind: 'absent' };
    } else if (stat.isSymbolicLink() && base.symlinks !== undefined) {
      assertExistingPathConfined(dirname(path), workspace.path);
      ours = { kind: 'symlink', target: await readlink(join(workspace.path, path)) };
    } else {
      ours = await readConfinedEntry(workspace.path, path);
    }
    const before = await readBaseEntry({
      ref,
      snapshotId: workspace.base.snapshotId,
      path,
      base,
      baseline,
      ours,
    });
    if (before.kind === 'symlink' || ours.kind === 'symlink') {
      if (before.kind === 'symlink' && ours.kind === 'symlink' && before.target === ours.target)
        continue;
    } else if (
      (before.kind === 'absent' && ours.kind === 'absent') ||
      (before.kind === 'file' &&
        ours.kind === 'file' &&
        before.sha256 === ours.sha256 &&
        (before.mode === undefined || before.mode === ours.mode))
    ) {
      continue;
    }

    if (path === '.gitignore' && before.kind !== 'symlink' && ours.kind !== 'symlink') {
      const oursText = ours.kind === 'file' ? ours.bytes.toString('utf8') : null;
      const baseText = before.kind === 'file' ? before.bytes.toString('utf8') : null;
      const strippedOurs = stripGitignoreBookkeeping(oursText, baseText);
      const sameMode =
        before.kind === 'absent' ||
        ours.kind === 'absent' ||
        before.mode === undefined ||
        before.mode === ours.mode;
      if (strippedOurs === stripGitignoreBookkeeping(baseText) && sameMode) continue;
      if (ours.kind === 'file') ours = { ...ours, bytes: Buffer.from(strippedOurs, 'utf8') };
    }

    changes.push({ path, base: before, ours });
  }

  const patchPath = join(sessionDir(projectDir, sessionId), RUN_PATCH_FILE);
  if (changes.length === 0) {
    await rm(patchPath, { force: true });
    return null;
  }

  const root = await mkdtemp(join(tmpdir(), 'splitbrief-run-patch-'));
  try {
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    for (const change of changes) {
      for (const [side, entry] of [
        ['a', change.base],
        ['b', change.ours],
      ] as const) {
        if (entry.kind === 'absent') continue;
        assertWritablePathConfined(change.path, join(root, side));
        const target = join(root, side, change.path);
        await mkdir(dirname(target), { recursive: true });
        if (entry.kind === 'symlink') {
          await symlink(entry.target, target);
        } else {
          // Without a recorded base mode, both sides use the workspace mode for content diffs.
          const mode =
            (change.base.kind === 'file' &&
            change.base.mode === undefined &&
            change.ours.kind === 'file'
              ? change.ours.mode
              : entry.mode) ?? 0o644;
          await writeFile(target, entry.bytes, { mode });
          await chmod(target, mode);
        }
      }
    }
    const patch = await runGitDiff(root);
    if (patch === '') {
      await rm(patchPath, { force: true });
      return null;
    }
    await writeFile(patchPath, patch, { mode: 0o600 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return patchPath;
}
