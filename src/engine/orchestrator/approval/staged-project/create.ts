import { rmSync, type Stats } from 'node:fs';
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';
import { INTERNAL_SKIP_DIRS } from '../../../../core/paths.js';
import type { Config } from '../../../../core/schemas/config.js';
import { assertWritablePathConfined } from '../../../../lib/fs/confinement.js';
import { createGitClient, runGit } from '../../../../lib/git/client.js';
import { listTrackedAndUntrackedFiles } from '../../../../lib/git/files.js';
import { GIT_EMPTY_TREE_HASH } from '../../../../lib/git/refs.js';
import { getRepoToplevel } from '../../../../lib/git/repository.js';
import { isENOENT } from '../../../../utils/errno.js';
import { createRunnerSandboxEnv, createSandboxEnv } from '../../../runners/sandbox/env.js';
import { removeSandboxTempDirs } from '../../../runners/sandbox/state/paths.js';
import type { IsolationRole, IsolatedWorkspace } from '../../isolation/types.js';
import { getChangedFilesSnapshot, captureProjectFileHashes } from '../file-snapshots/capture.js';
import { captureAcquisitionBaseline } from '../file-snapshots/entry/baseline.js';
import { readProjectSymlink } from '../file-snapshots/entry/link.js';

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

export async function lstatIfPresent(source: string): Promise<Stats | null> {
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
  gitRoot: boolean,
): Promise<Record<string, string>> {
  const links: Record<string, string> = {};
  const entries = gitRoot ? await listTrackedAndUntrackedFiles(projectDir) : null;
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

async function copyPinnedTree(
  projectDir: string,
  stagedProjectDir: string,
  head: string,
): Promise<Record<string, string>> {
  const temporary = await mkdtemp(join(tmpdir(), 'splitbrief-committed-tree-'));
  try {
    const tree = join(temporary, 'tree');
    await mkdir(tree);
    const git = createGitClient(projectDir, {
      indexFile: join(temporary, 'index'),
      worktreeDir: tree,
    });
    await runGit('read-tree', () => git.raw(['read-tree', head]));
    await runGit('checkout-index', () =>
      git.raw(['checkout-index', '--all', '--ignore-skip-worktree-bits', `--prefix=${tree}/`]),
    );
    return await copyProjectFiles(tree, stagedProjectDir, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createStagedProject(input: {
  projectDir: string;
  config?: Config | undefined;
  role?: IsolationRole | undefined;
  ownedRoot?: string | undefined;
  pinnedHead?: string | undefined;
}): Promise<IsolatedWorkspace> {
  const { projectDir, config, role = 'implementer', ownedRoot, pinnedHead } = input;
  // Before the copy, so an edit racing the copy lands on the worker's side of
  // the baseline and is reported as a conflict rather than silently overwritten.
  const targetBaseline =
    pinnedHead === undefined ? await captureAcquisitionBaseline(projectDir) : undefined;
  // The staged copy carries only the symlinks that stay inside the project, so
  // the snapshot describes the tree the worker receives: any other source
  // symlink is recorded as absent, not refused — this strategy is the fallback
  // for exactly those sources.
  const top = pinnedHead === undefined ? await getRepoToplevel(projectDir) : null;
  const gitRoot = top !== null && (await realpath(top)) === (await realpath(projectDir));
  const snapshot = gitRoot
    ? await getChangedFilesSnapshot(projectDir, undefined, { symlinkedEntriesAsAbsent: true })
    : { head: pinnedHead ?? GIT_EMPTY_TREE_HASH, files: [], dirtyFileContents: {} };
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
    const symlinks =
      pinnedHead === undefined
        ? await copyProjectFiles(projectDir, stagedProjectDir, gitRoot)
        : await copyPinnedTree(projectDir, stagedProjectDir, pinnedHead);
    const baselineFileHashes = await captureProjectFileHashes(stagedProjectDir, {
      ignoreProjectDir: pinnedHead === undefined ? projectDir : null,
    });
    const sandboxEnv = config
      ? await createRunnerSandboxEnv(stagedProjectDir, config[role], role)
      : await createSandboxEnv({ projectDir: stagedProjectDir });
    return {
      projectDir: stagedProjectDir,
      sandboxEnv,
      snapshot: {
        ...snapshot,
        baselineFileHashes,
        ignoreProjectDir: pinnedHead === undefined ? projectDir : null,
        symlinks,
      },
      targetBaseline:
        targetBaseline ??
        (await captureAcquisitionBaseline(stagedProjectDir, { ignoreProjectDir: null })),
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
