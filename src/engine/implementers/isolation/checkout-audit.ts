import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import { isInternalGitStatusPath } from '../../../core/paths.js';
import { getGitForDir } from '../../../lib/git/client.js';
import { getCurrentChangedFiles } from '../../../lib/git/files.js';
import { isGitRepo } from '../../../lib/git/repository.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { hashFiles } from '../../change-detection.js';
import { collectTrackedFiles, hashFile } from '../../snapshots/files.js';

/** The lockfiles a package manager rewrites whenever it changes the installed tree. */
export const DEPENDENCY_MARKERS = [
  '.package-lock.json',
  '.modules.yaml',
  '.yarn-state.yml',
  '.yarn-integrity',
];

/**
 * What an implementer call could change in the checkout the run promotes into,
 * without going through promotion: its files as git reports them, and the git
 * state every linked worktree shares — refs, stash, hooks and config — plus the
 * installed dependencies the isolation directory links to. Remote-tracking and
 * `git maintenance` prefetch refs are copies of the remote, and `splitbrief/`
 * branches are SPLITBRIEF's own isolation branches, so none of them is the
 * checkout's state. `branch` names the ref HEAD points at; Apply merges a move
 * of it, so `checkoutChanges` does not compare it.
 */
export type CheckoutSnapshot = Readonly<{
  files: Readonly<Record<string, string | null>>;
  refs: Readonly<Record<string, string>>;
  branch: string | null;
  stash: string | null;
  hooks: Readonly<Record<string, string | null>>;
  config: string;
  dependencies: string | null;
}>;

async function gitOutput(dir: string, args: string[]): Promise<string> {
  return (await getGitForDir(dir).raw(args)).trim();
}

async function readText(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

/** The branch name a git HEAD file names, or null when HEAD is detached. */
function branchName(head: string): string | null {
  const ref = head.startsWith('ref: ') ? head.slice('ref: '.length).trim() : '';
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

async function snapshotRefs(dir: string): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  const listing = await gitOutput(dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
  for (const line of listing.split('\n')) {
    const [name, oid] = line.split(' ');
    if (name === undefined || oid === undefined) continue;
    // The stash is read whole from its log below; `refs/stash` alone misses a dropped entry.
    if (name === 'refs/stash' || /^refs\/(?:remotes|prefetch)\//.test(name)) continue;
    if (name.startsWith(`refs/heads/${SPLITBRIEF_IDENTITY.branchPrefix}`)) continue;
    refs[name] = oid;
  }
  return refs;
}

async function snapshotHooks(commonDir: string): Promise<Record<string, string | null>> {
  let names: string[];
  try {
    names = await readdir(join(commonDir, 'hooks'));
  } catch {
    return {};
  }
  return hashFiles(join(commonDir, 'hooks'), names);
}

async function snapshotDependencies(checkoutDir: string): Promise<string | null> {
  const dir = join(checkoutDir, 'node_modules');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  // Tool caches (`.vite`, `.cache`) come and go on every test run; packages and lockfiles do not.
  const packages = names.filter((name) => !name.startsWith('.')).sort();
  const markers = await Promise.all(DEPENDENCY_MARKERS.map((name) => hashFile(join(dir, name))));
  return sha256Hex(JSON.stringify([packages, markers]));
}

/** Throws when git cannot read a repository it reports: the caller decides what an unread checkout means. */
export async function snapshotCheckout(checkoutDir: string): Promise<CheckoutSnapshot> {
  const dependencies = await snapshotDependencies(checkoutDir);
  if (!(await isGitRepo(checkoutDir))) {
    return {
      files: await hashFiles(checkoutDir, await collectTrackedFiles(checkoutDir)),
      refs: {},
      branch: null,
      stash: null,
      hooks: {},
      config: '',
      dependencies,
    };
  }
  const [gitDir = '', commonDir = ''] = (
    await gitOutput(checkoutDir, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])
  ).split('\n');
  const common = resolve(checkoutDir, commonDir);
  const changed = (await getCurrentChangedFiles(checkoutDir)).filter(
    (file) => !isInternalGitStatusPath(file),
  );
  const configs = await Promise.all(
    ['config', 'config.worktree'].map((name) => hashFile(join(common, name))),
  );
  const head = await readText(join(gitDir, 'HEAD'));
  const name = branchName(head);
  return {
    files: await hashFiles(checkoutDir, changed),
    refs: await snapshotRefs(checkoutDir),
    branch: name === null ? null : `refs/heads/${name}`,
    stash: await hashFile(join(common, 'logs', 'refs', 'stash')),
    hooks: await snapshotHooks(common),
    config: configs.join(' '),
    dependencies,
  };
}

function changedKeys(
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

/**
 * The run worktree's own git state — its HEAD, the branch HEAD names and its
 * index entries and flags. The index hash uses `ls-files --stage -v`, which
 * excludes the stat cache `git status` and `git diff` update. `branch` is null
 * for detached HEAD and empty for an unborn branch.
 */
export type WorkspaceGitSnapshot = Readonly<{
  head: string;
  branch: string | null;
  index: string;
}>;

/**
 * The git state of a directory that is the top level of its own work tree, or
 * null when it is not a git repo or git answers for an enclosing checkout: a
 * staged copy inside the checkout is not the run worktree.
 */
export async function snapshotWorkspaceGit(
  workspaceDir: string,
): Promise<WorkspaceGitSnapshot | null> {
  if (!(await isGitRepo(workspaceDir))) return null;
  const toplevel = await gitOutput(workspaceDir, ['rev-parse', '--show-toplevel']);
  if ((await realpath(workspaceDir)) !== (await realpath(toplevel))) return null;
  const gitDir = await gitOutput(workspaceDir, ['rev-parse', '--absolute-git-dir']);
  const head = await readText(join(gitDir, 'HEAD'));
  const name = branchName(head);
  const branch =
    name === null
      ? null
      : await gitOutput(workspaceDir, [
          'for-each-ref',
          '--format=%(objectname)',
          `refs/heads/${name}`,
        ]);
  return {
    head,
    branch,
    index: sha256Hex(await gitOutput(workspaceDir, ['ls-files', '--stage', '-v'])),
  };
}

function refLabel(ref: string): string {
  if (ref.startsWith('refs/heads/')) return `branch ${ref.slice('refs/heads/'.length)}`;
  if (ref.startsWith('refs/tags/')) return `tag ${ref.slice('refs/tags/'.length)}`;
  return ref;
}

/**
 * What changed in the checkout between two snapshots, each named the way the
 * operator would look for it. `files` are project-relative paths, which an
 * editor save changes as readily as a tool; `state` is what no editor touches —
 * `branch topic`, `stash`, `hook pre-commit`, `git config`, `node_modules`. A
 * move of the checkout's HEAD or current branch is Apply's own work, so it is
 * not state.
 */
export function checkoutChanges({
  before,
  after,
}: Readonly<{ before: CheckoutSnapshot; after: CheckoutSnapshot }>): {
  files: string[];
  state: string[];
} {
  return {
    files: changedKeys(before.files, after.files),
    state: [
      ...changedKeys(before.refs, after.refs)
        .filter((ref) => ref !== before.branch && ref !== after.branch)
        .map(refLabel),
      ...(before.stash === after.stash ? [] : ['stash']),
      ...changedKeys(before.hooks, after.hooks).map((hook) => `hook ${hook}`),
      ...(before.config === after.config ? [] : ['git config']),
      ...(before.dependencies === after.dependencies ? [] : ['node_modules']),
    ],
  };
}

/**
 * What changed in the run worktree's own git between two snapshots. A moved
 * HEAD is named instead of the branch; the branch is named when it moved under
 * an unchanged HEAD (a commit or a reset). Index changes are named separately.
 * Losing or gaining git of its own is `run worktree git`; two null snapshots
 * are unchanged.
 */
export function workspaceGitChanges({
  before,
  after,
}: Readonly<{
  before: WorkspaceGitSnapshot | null;
  after: WorkspaceGitSnapshot | null;
}>): string[] {
  if (before === null || after === null) {
    return before === after ? [] : ['run worktree git'];
  }
  const changes: string[] = [];
  if (before.head !== after.head) changes.push('run worktree HEAD');
  else if (before.branch !== after.branch) {
    changes.push(`run worktree branch ${branchName(before.head)}`);
  }
  if (before.index !== after.index) changes.push('run worktree index');
  return changes;
}

const LISTED_CHANGES = 8;

/**
 * `src/app.ts · branch main · 3 more` — the changes on one line, for the caller
 * to put its own verb before. The audit sees what changed, not who changed it:
 * an edit of yours or a hook's lands here too.
 */
export function formatCheckoutChanges(changes: readonly string[]): string {
  const listed = changes.slice(0, LISTED_CHANGES).join(' · ');
  const more = changes.length - LISTED_CHANGES;
  return more > 0 ? `${listed} · ${more} more` : listed;
}
