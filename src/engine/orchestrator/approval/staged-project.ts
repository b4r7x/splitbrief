import { rmSync, type Stats } from 'node:fs';
import { cp, copyFile, lstat, mkdir, mkdtemp, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import type { EvidencePromotedFile } from '../../../core/schemas/evidence.js';
import { INTERNAL_SKIP_DIRS, SPLITBRIEF_DIR, TREES_DIR } from '../../../core/paths.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import { listTrackedAndUntrackedFiles } from '../../../lib/git/files.js';
import { GIT_EMPTY_TREE_HASH } from '../../../lib/git/refs.js';
import { isGitRepo } from '../../../lib/git/repository.js';
import {
  assertPathConfined,
  assertWritablePathConfined,
  reachesControlPlane,
} from '../../../lib/path-confinement.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { error } from '../../../utils/error.js';
import { createRunnerSandboxEnv, createSandboxEnv } from '../../runners/sandbox-env.js';
import { removeSandboxTempDirs } from '../../runners/sandbox-state-paths.js';
import { captureProjectFileHashes, getChangedFilesSnapshot } from './file-snapshots/capture.js';
import { readCurrentFileContent } from './file-snapshots/contents.js';
import {
  type AcquisitionBaseline,
  captureAcquisitionBaseline,
  matchesAcquisitionBaseline,
  readConfinedEntry,
  readProjectSymlink,
  sameFileEntry,
  writeConfinedEntry,
  type FileSnapshotEntry,
} from './file-snapshots/entry.js';
import type { IsolationRole, IsolatedWorkspace } from '../isolation/types.js';

/** Which file's apply failed and why; the promotion stopped there. */
export type PromotionFailure = { failedFile: string; error: unknown };

export type PromoteStagedChangesResult = {
  promotedFiles: string[];
  conflictedFiles: string[];
  failure?: PromotionFailure;
  /** Exact entries this call wrote, including a stopped prefix. */
  appliedFiles?: EvidencePromotedFile[];
};

export const stagedProjectError = {
  conflict: (file: string) =>
    error('approval-promotion-conflict', `Target changed before promotion: ${file}`, { file }),
} as const;

const GITIGNORE_FILE = '.gitignore';
const GITIGNORE_BOOKKEEPING_LINES = new Set([`${SPLITBRIEF_DIR}/`, `${TREES_DIR}/`]);

// Isolation appends these entries to the worktree's own .gitignore, so a bookkeeping
// line the project's copy does not already carry is SPLITBRIEF's and never the task's.
export function stripGitignoreBookkeeping(
  text: string | null,
  projectText: string | null = null,
): string {
  if (text === null) return '';
  const projectLines = new Set((projectText ?? '').split('\n').map((line) => line.trim()));
  return text
    .split('\n')
    .filter((line) => {
      const entry = line.trim();
      return !GITIGNORE_BOOKKEEPING_LINES.has(entry) || projectLines.has(entry);
    })
    .join('\n');
}

const STAGED_COPY_EXCLUDE = new Set([
  ...INTERNAL_SKIP_DIRS,
  '.env',
  '.npmrc',
  '.netrc',
  '.git-credentials',
]);

function isStagedCopyExcluded(name: string): boolean {
  return STAGED_COPY_EXCLUDE.has(name) || name.startsWith('.env');
}

function shouldCopyGitListedEntry(entry: string): boolean {
  if (entry.endsWith('/')) return false;
  const firstSegment = entry.split('/')[0] ?? '';
  if (INTERNAL_SKIP_DIRS.includes(firstSegment)) return false;
  return !isStagedCopyExcluded(basename(entry));
}

async function lstatIfPresent(source: string): Promise<Stats | null> {
  try {
    return await lstat(source);
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

// A symlink is copied only when it stays inside the project: its relative target
// then resolves inside the staged copy too. Every other link is left out. The
// copied links come back by path, since the content hashes never see a link.
async function copyProjectFiles(
  projectDir: string,
  stagedProjectDir: string,
): Promise<Record<string, string>> {
  const links: Record<string, string> = {};
  const entries = await listTrackedAndUntrackedFiles(projectDir);
  if (entries === null) {
    // Copied entry by entry: an owned staged root lives inside the project, and a
    // whole-directory copy into its own subdirectory is refused.
    for (const name of await readdir(projectDir)) {
      if (isStagedCopyExcluded(name)) continue;
      await cp(join(projectDir, name), join(stagedProjectDir, name), {
        recursive: true,
        verbatimSymlinks: true,
        filter: async (source) => {
          if (isStagedCopyExcluded(basename(source))) return false;
          if (!(await lstat(source)).isSymbolicLink()) return true;
          const file = relative(projectDir, source);
          const link = await readProjectSymlink(projectDir, file);
          if (link === null) return false;
          links[file] = link;
          return true;
        },
      });
    }
    return links;
  }
  for (const entry of entries) {
    if (!shouldCopyGitListedEntry(entry)) continue;
    const source = join(projectDir, entry);
    const stats = await lstatIfPresent(source);
    if (stats === null) continue;
    const target = join(stagedProjectDir, entry);
    if (stats.isSymbolicLink()) {
      const link = await readProjectSymlink(projectDir, entry);
      if (link === null) continue;
      links[entry] = link;
      await mkdir(dirname(target), { recursive: true });
      await symlink(link, target);
    } else if (stats.isFile()) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
  return links;
}

export async function createStagedProject(input: {
  projectDir: string;
  config?: Config | undefined;
  role?: IsolationRole | undefined;
  ownedRoot?: string | undefined;
}): Promise<IsolatedWorkspace> {
  const { projectDir, config, role = 'implementer', ownedRoot } = input;
  // Before the copy, so an edit racing the copy lands on the worker's side of
  // the baseline and is reported as a conflict rather than silently overwritten.
  const targetBaseline = await captureAcquisitionBaseline(projectDir);
  // The staged copy carries only the symlinks that stay inside the project, so
  // the snapshot describes the tree the worker receives: any other source
  // symlink is recorded as absent, not refused — this strategy is the fallback
  // for exactly those sources.
  const snapshot = (await isGitRepo(projectDir))
    ? await getChangedFilesSnapshot(projectDir, undefined, { symlinkedEntriesAsAbsent: true })
    : { head: GIT_EMPTY_TREE_HASH, files: [], dirtyFileContents: {} };
  const stagedRoot =
    ownedRoot ?? (await mkdtemp(join(tmpdir(), `${SPLITBRIEF_IDENTITY.slug}-stage-`)));
  try {
    const stagedProjectDir = join(
      stagedRoot,
      ownedRoot === undefined ? basename(projectDir) : 'workspace',
    );
    // Git can legitimately return no copyable entries (an empty repository or
    // a project whose files are all excluded). The hash walk still needs a
    // real staged root in that case.
    if (ownedRoot !== undefined)
      assertWritablePathConfined(relative(projectDir, stagedProjectDir), projectDir);
    await mkdir(stagedProjectDir, { recursive: true });
    if (ownedRoot !== undefined)
      assertWritablePathConfined(relative(projectDir, stagedProjectDir), projectDir);
    const symlinks = await copyProjectFiles(projectDir, stagedProjectDir);
    const baselineFileHashes = await captureProjectFileHashes(stagedProjectDir, {
      ignoreProjectDir: projectDir,
    });
    const sandboxEnv = config
      ? await createRunnerSandboxEnv(stagedProjectDir, config[role], role)
      : await createSandboxEnv({ projectDir: stagedProjectDir });
    return {
      projectDir: stagedProjectDir,
      sandboxEnv,
      snapshot: { ...snapshot, baselineFileHashes, ignoreProjectDir: projectDir, symlinks },
      targetBaseline,
      cleanup: () => {
        rmSync(stagedRoot, { recursive: true, force: true });
        removeSandboxTempDirs(stagedProjectDir);
      },
    };
  } catch (err) {
    rmSync(stagedRoot, { recursive: true, force: true });
    throw err;
  }
}

async function entryToPromote(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  file: string;
}): Promise<FileSnapshotEntry> {
  const { targetProjectDir, stagedProjectDir, file } = opts;
  const staged = await readConfinedEntry(stagedProjectDir, file);
  if (file !== GITIGNORE_FILE || staged.kind !== 'file') return staged;
  // The .gitignore is the only promoted file whose bytes are decoded: it keeps
  // its bookkeeping strip; every other file is carried byte for byte with its
  // ordinary permission bits.
  const bytes = Buffer.from(
    stripGitignoreBookkeeping(
      staged.bytes.toString('utf8'),
      await readCurrentFileContent(targetProjectDir, file),
    ),
    'utf8',
  );
  return { kind: 'file', bytes, sha256: sha256Hex(bytes), mode: staged.mode };
}

/**
 * The target already holds exactly what this promotion would write. That is a promotion that
 * already happened — the operator applied the same change, or an earlier attempt got there —
 * and rewriting it would only fail the acquisition recheck.
 */
async function targetHoldsStagedEntry(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  file: string;
}): Promise<boolean> {
  const staged = await entryToPromote(opts);
  const current = await readConfinedEntry(opts.targetProjectDir, opts.file);
  return sameFileEntry(current, staged);
}

export async function promoteStagedChanges(opts: {
  targetProjectDir: string;
  stagedProjectDir: string;
  files: string[];
  targetBaseline: AcquisitionBaseline | undefined;
}): Promise<PromoteStagedChangesResult> {
  const { targetProjectDir, stagedProjectDir, files, targetBaseline } = opts;
  for (const file of files) {
    assertWritablePathConfined(file, targetProjectDir);
    assertPathConfined(file, stagedProjectDir);
  }
  // A workspace acquired without a baseline holds no authority over the target:
  // an unknown target is a conflict, never an overwrite.
  if (targetBaseline === undefined) return { promotedFiles: [], conflictedFiles: [...files] };

  const preflight = await Promise.all(
    files.map(async (file): Promise<'ok' | 'settled' | 'conflict'> => {
      // Promotion writes regular files only: a symlink on either side is left
      // for the operator, never written over, through or from.
      const [target, staged] = await Promise.all([
        lstatIfPresent(join(targetProjectDir, file)),
        lstatIfPresent(join(stagedProjectDir, file)),
      ]);
      if (target?.isSymbolicLink() || staged?.isSymbolicLink()) return 'conflict';
      // A symlinked parent in the target that resolves into `.git` or `.splitbrief`
      // would carry the file into the control plane; the approval saw only its spelling.
      if (reachesControlPlane(file, targetProjectDir)) return 'conflict';
      if (await matchesAcquisitionBaseline(targetProjectDir, file, targetBaseline)) return 'ok';
      return (await targetHoldsStagedEntry({ targetProjectDir, stagedProjectDir, file }))
        ? 'settled'
        : 'conflict';
    }),
  );
  const conflictedFiles = files.filter((_, index) => preflight[index] === 'conflict');
  if (conflictedFiles.length > 0) {
    return { promotedFiles: [], conflictedFiles };
  }
  const settledFiles = new Set(files.filter((_, index) => preflight[index] === 'settled'));

  const promotedFiles: string[] = [];
  const appliedFiles: EvidencePromotedFile[] = [];
  for (const file of files) {
    const conflict = stagedProjectError.conflict(file);
    try {
      const entry = await entryToPromote({ targetProjectDir, stagedProjectDir, file });
      // Recheck after preparing bytes and mode, immediately before replacement.
      // A filesystem rename is atomic, but is not a portable compare-and-swap.
      if (!settledFiles.has(file)) {
        await writeConfinedEntry(targetProjectDir, file, entry, async () => {
          if (!(await matchesAcquisitionBaseline(targetProjectDir, file, targetBaseline))) {
            throw conflict;
          }
        });
        appliedFiles.push(
          entry.kind === 'file'
            ? {
                path: file,
                sha256: entry.sha256,
                mode: entry.mode & 0o777,
                ...(!targetBaseline.has(file) ? { created: true as const } : {}),
              }
            : { path: file, sha256: null, mode: null },
        );
      }
    } catch (err) {
      if (err === conflict) return { promotedFiles, conflictedFiles: [file], appliedFiles };
      // A failed apply stops the promotion where it stands. Nothing is rolled
      // back and no later file is attempted, so promotedFiles is the exact
      // prefix the target now holds and the rest is untouched.
      return {
        promotedFiles,
        conflictedFiles: [],
        appliedFiles,
        failure: { failedFile: file, error: err },
      };
    }
    promotedFiles.push(file);
  }

  return { promotedFiles, conflictedFiles, appliedFiles };
}
