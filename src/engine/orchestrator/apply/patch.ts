import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isInternalGitStatusPath,
  RUN_PATCH_FILE,
  sessionDir,
  SNAPSHOT_BASELINE_ID,
} from '../../../core/paths.js';
import type { SnapshotManifest } from '../../../core/schemas/snapshot.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { gitBinary } from '../../../lib/git/client.js';
import { assertPathConfined } from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { resolveValidatedBlobPath } from '../../snapshots/blob-resolver.js';
import { collectTrackedFiles, hashFile } from '../../snapshots/files.js';
import { readManifest } from '../../snapshots/manifest.js';
import { readConfinedEntry } from '../approval/file-snapshots/entry.js';
import { stripGitignoreBookkeeping } from '../approval/staged-project.js';

type WorkspaceBase = { path: string; base: { snapshotId: string } };

type ChangedPath = {
  path: string;
  baseBytes: Buffer | null;
  oursBytes: Buffer | null;
  mode: number;
};

async function readBaseBytes(input: {
  ref: SessionRef;
  snapshotId: string;
  path: string;
  baseHash: string;
  base: SnapshotManifest;
  baseline: SnapshotManifest;
}): Promise<Buffer> {
  const { ref, snapshotId, path, baseHash, base, baseline } = input;
  const entry = base.fileEntries.find((candidate) => candidate.path === path);
  const inherited = entry === undefined && baseline.fileHashes[path] === baseHash;
  const resolvedEntry = inherited
    ? baseline.fileEntries.find((candidate) => candidate.path === path)
    : entry;
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
  return readFile(blobPath);
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
  const base = await readManifest(projectDir, sessionId, workspace.base.snapshotId);
  const baseline = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
  const tracked = await collectTrackedFiles(workspace.path, { ignoreProjectDir: projectDir });
  const paths = [...new Set([...Object.keys(base.fileHashes), ...tracked])]
    .filter((path) => !isInternalGitStatusPath(path))
    .sort();

  const changes: ChangedPath[] = [];
  for (const path of paths) {
    assertPathConfined(path, workspace.path);
    const baseHash = base.fileHashes[path];
    const oursHash = await hashFile(join(workspace.path, path));
    if (oursHash === null) {
      const entry = await lstat(join(workspace.path, path)).catch((err: unknown) => {
        if (isENOENT(err)) return null;
        throw err;
      });
      if (entry !== null) {
        throw error(
          'run-patch-workspace-unreadable',
          `Cannot write the run patch: workspace contents for ${path} could not be read.`,
          { path },
        );
      }
    }
    const baseAbsent = baseHash === undefined;
    const oursAbsent = oursHash === null;
    if ((baseAbsent && oursAbsent) || (!baseAbsent && !oursAbsent && baseHash === oursHash)) {
      continue;
    }

    const baseBytes = baseAbsent
      ? null
      : await readBaseBytes({
          ref,
          snapshotId: workspace.base.snapshotId,
          path,
          baseHash,
          base,
          baseline,
        });
    const ours = await readConfinedEntry(workspace.path, path);
    let oursBytes: Buffer | null = ours.kind === 'file' ? ours.bytes : null;
    const mode = ours.kind === 'file' ? ours.mode : 0o644;

    if (path === '.gitignore') {
      const oursText = oursBytes === null ? null : oursBytes.toString('utf8');
      const baseText = baseBytes === null ? null : baseBytes.toString('utf8');
      const strippedOurs = stripGitignoreBookkeeping(oursText, baseText);
      if (strippedOurs === stripGitignoreBookkeeping(baseText)) continue;
      if (oursBytes !== null) oursBytes = Buffer.from(strippedOurs, 'utf8');
    }

    changes.push({ path, baseBytes, oursBytes, mode });
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
      for (const [side, bytes] of [
        ['a', change.baseBytes],
        ['b', change.oursBytes],
      ] as const) {
        if (bytes === null) continue;
        assertPathConfined(change.path, join(root, side));
        const target = join(root, side, change.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { mode: change.mode });
      }
    }
    await writeFile(patchPath, await runGitDiff(root), { mode: 0o600 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return patchPath;
}
