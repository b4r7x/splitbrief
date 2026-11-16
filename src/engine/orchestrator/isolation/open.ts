import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { createGitClient } from '../../../lib/git/client.js';
import { getCurrentCommitSha } from '../../../lib/git/refs.js';
import {
  getGitCommonDir,
  hasCommits,
  isGitRepo,
  readHeadSha,
} from '../../../lib/git/repository.js';
import { addWorkspaceRoot, toErrorMessage } from '../../../utils/format/errors.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import {
  captureAcquisitionBaseline,
  type AcquisitionBaseline,
} from '../approval/file-snapshots/entry/baseline.js';
import { createStagedProject } from '../approval/staged-project/create.js';
import { prepareWorktreeAcquisition } from './acquisition.js';
import { trackOperation } from './dispose.js';
import { captureWorkspaceSnapshot } from './entry-snapshot.js';
import { resolveConfinedIsolationWorktreePath } from './path.js';
import {
  readWorkspaceRecord,
  retainedDirectoryMatches,
  retainedStagedDirectory,
  retainWorkspaceRecord,
  retentionError,
  stagedWorkspaceRoot,
  workspaceDirectoryIdentity,
  workspaceIdentityMatches,
  workspaceOwner,
} from './retention.js';
import type { IsolatedWorkspace, RunIsolation, RunIsolationState, RunWorkspace } from './types.js';
import { ensureIsolationWorktree } from './worktree/ensure.js';

/** The worktree, or null for a staged copy, with the target inputs a new worktree starts from. */
type ResolvedWorktree = {
  dir: string | null;
  initialTargetBaseline: AcquisitionBaseline | undefined;
};

function reportFallback(state: RunIsolationState, reason: string): void {
  if (state.fallbackReported) return;
  state.fallbackReported = true;
  state.opts.onFallback(reason);
}

function abandonWorktree(state: RunIsolationState, reason: string): ResolvedWorktree {
  if (state.worktree !== null) state.worktree.abandoned = true;
  reportFallback(state, reason);
  return { dir: null, initialTargetBaseline: undefined };
}

async function resolveWorktreeDir(state: RunIsolationState): Promise<ResolvedWorktree> {
  const { projectDir, sessionId } = state.opts;
  if (!(await isGitRepo(projectDir))) {
    reportFallback(state, 'project is not a git repository');
    return { dir: null, initialTargetBaseline: undefined };
  }
  if (!(await hasCommits(projectDir))) {
    reportFallback(state, 'repository has no commits');
    return { dir: null, initialTargetBaseline: undefined };
  }
  const git = createGitClient(projectDir);
  try {
    const targetBeforeCreation = await captureAcquisitionBaseline(projectDir);
    const result = await ensureIsolationWorktree({
      projectDir,
      sessionId,
      git,
      onWorktreeCreated: (path) => {
        state.worktree = { dir: path, git, abandoned: false };
      },
      onNodeModulesExcluded: (file) => {
        state.nodeModulesExcludeFile = file;
      },
    });
    if (result.kind === 'fallback') return abandonWorktree(state, result.reason);
    state.worktree = { dir: result.worktreePath, git, abandoned: false };
    return {
      dir: result.worktreePath,
      initialTargetBaseline: result.reused ? undefined : targetBeforeCreation,
    };
  } catch (err) {
    return abandonWorktree(state, toErrorMessage(err));
  }
}

export async function assertWorkspaceIdentity(
  state: RunIsolationState,
  dir: string,
): Promise<void> {
  if (!(await workspaceIdentityMatches(state, dir))) throw retentionError.unavailable();
}

export async function saveRecord(
  state: RunIsolationState,
  workspace: IsolatedWorkspace,
  retained: boolean,
): Promise<void> {
  const { projectDir, sessionId } = state.opts;
  const { owner, location } = state;
  if (owner === undefined || location === undefined) throw retentionError.unavailable();
  await retainWorkspaceRecord({ projectDir, sessionId }, { workspace, owner, location, retained });
  state.retained = retained;
}

export function open(
  state: RunIsolationState,
  input: Parameters<RunIsolation['open']>[0],
): Promise<RunWorkspace> {
  if (state.disposed) return Promise.reject(retentionError.unavailable());
  if (state.openPromise === undefined) {
    state.openPromise = trackOperation(state, openWorkspace(state, input.config, input.recorded));
  }
  return state.openPromise;
}

async function openWorkspace(
  state: RunIsolationState,
  config: Config,
  recorded: RunWorkspace['kind'] | undefined,
): Promise<RunWorkspace> {
  const { projectDir, sessionId, strategy } = state.opts;
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  const previous = await readWorkspaceRecord(ref);
  if (state.disposed) throw retentionError.unavailable();
  // The checkout mode keeps no workspace of its own: the run works in the project itself, and a
  // run records its mode once, so a later config edit cannot move it.
  if (
    previous === null &&
    (recorded === 'checkout' || (recorded === undefined && strategy === 'none'))
  ) {
    const checkout: RunWorkspace = {
      kind: 'checkout',
      projectDir,
      head: await readHeadSha(projectDir),
      keptFiles: [],
    };
    state.runWorkspace = checkout;
    return checkout;
  }
  let dir: string | null = null;
  let initialTargetBaseline: AcquisitionBaseline | undefined;
  if (previous !== null) {
    if (previous.location.kind === 'staged-copy') {
      dir = retainedStagedDirectory(ref, previous);
      if (strategy === 'worktree') reportFallback(state, 'resuming retained staged-copy workspace');
    } else {
      const gitCommonDir = await getGitCommonDir(projectDir);
      dir = resolveConfinedIsolationWorktreePath({
        projectDir,
        gitCommonDir,
        slug: sessionId.slice(0, 64),
      });
    }
    if (
      dir === null ||
      !(await retainedDirectoryMatches(previous, dir)) ||
      (previous.location.kind === 'staged-copy' &&
        !(await retainedDirectoryMatches(
          { directory: previous.location.rootDirectory },
          dirname(dir),
        )))
    )
      throw retentionError.unavailable();
    state.location = previous.location;
    state.directory = previous.directory;
    state.retained = previous.retained;
    if (previous.retained) state.retainedAttempt = previous;
    if (previous.location.kind === 'worktree' && (await resolveWorktreeDir(state)).dir !== dir)
      throw retentionError.unavailable();
    await assertWorkspaceIdentity(state, dir);
  } else if (strategy !== 'staged-copy') {
    ({ dir, initialTargetBaseline } = await resolveWorktreeDir(state));
  }
  if (dir === null) {
    const leaf = `stage-${randomBytes(16).toString('hex')}`;
    const root = stagedWorkspaceRoot(ref, leaf);
    const staged = await createStagedProject({
      projectDir,
      config,
      role: 'implementer',
      ownedRoot: root,
    });
    dir = staged.projectDir;
    initialTargetBaseline = staged.targetBaseline;
    state.sandboxEnvs.seedImplementerEnv(dir, config, staged.sandboxEnv);
    const rootDirectory = await workspaceDirectoryIdentity(root);
    if (rootDirectory === null) throw retentionError.unavailable();
    state.location = { kind: 'staged-copy', leaf, rootDirectory };
  } else if (state.location === undefined) {
    state.location = { kind: 'worktree' };
  }
  const { location } = state;
  const identity = await workspaceDirectoryIdentity(dir);
  if (identity === null) throw retentionError.unavailable();
  state.directory = identity;
  state.owner = workspaceOwner({ sessionId, config });
  const { targetBaseline } = await prepareWorktreeAcquisition({
    projectDir,
    sessionId,
    worktreeDir: dir,
    initialTargetBaseline,
  });
  const snapshot = await captureWorkspaceSnapshot(dir, ref);
  const keptFiles =
    state.retainedAttempt === null
      ? []
      : await getChangedFilesSinceSnapshot(dir, state.retainedAttempt.snapshot);
  state.removeWorkspaceRoot = addWorkspaceRoot(dir);
  const workspace: RunWorkspace = {
    kind: location.kind,
    projectDir: dir,
    head: location.kind === 'worktree' ? await getCurrentCommitSha(dir) : null,
    keptFiles,
  };
  state.runWorkspace = workspace;
  if (state.disposed) throw retentionError.unavailable();
  await saveRecord(
    state,
    {
      projectDir: dir,
      sandboxEnv: {},
      snapshot: state.retainedAttempt?.snapshot ?? snapshot,
      targetBaseline,
      cleanup: () => {},
    },
    state.retainedAttempt !== null,
  );
  return workspace;
}
