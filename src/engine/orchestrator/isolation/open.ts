import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { keepGitDiscoveryIn } from '../../../lib/git/discovery.js';
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
import { pinSeedIfCheckoutChanged, readWorkspaceSeed } from './seed.js';
import { ensureIsolationWorktree } from './worktree/ensure.js';
import { removeWorktree } from './worktree/remove.js';

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

async function resolveWorktreeDir(
  state: RunIsolationState,
  pinnedHead: string | undefined,
  reopening = false,
): Promise<ResolvedWorktree> {
  const { projectDir, sessionId } = state.opts;
  if (!(await isGitRepo(projectDir))) {
    reportFallback(state, 'project is not a git repository');
    return { dir: null, initialTargetBaseline: undefined };
  }
  if (!reopening && pinnedHead === undefined && !(await hasCommits(projectDir))) {
    reportFallback(state, 'repository has no commits');
    return { dir: null, initialTargetBaseline: undefined };
  }
  const git = createGitClient(projectDir);
  try {
    const targetBeforeCreation =
      !reopening && pinnedHead === undefined
        ? await captureAcquisitionBaseline(projectDir)
        : undefined;
    const result = await ensureIsolationWorktree({
      projectDir,
      sessionId,
      git,
      pinnedHead,
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
      initialTargetBaseline: result.reused
        ? undefined
        : (targetBeforeCreation ?? (await captureAcquisitionBaseline(result.worktreePath))),
    };
  } catch (err) {
    return abandonWorktree(state, toErrorMessage(err));
  }
}

async function createWorkspace(
  state: RunIsolationState,
  config: Config,
  strategy: IsolationStrategy,
  pinnedHead: string | undefined,
) {
  const { projectDir, sessionId } = state.opts;
  if (strategy !== 'staged-copy') {
    const opened = await resolveWorktreeDir(state, pinnedHead);
    if (opened.dir !== null && state.worktree !== null) {
      const { dir, git } = state.worktree;
      state.location = { kind: 'worktree' };
      return {
        dir,
        initialTargetBaseline: opened.initialTargetBaseline,
        discard: async () => {
          await removeWorktree({
            projectDir,
            slug: sessionId.slice(0, 64),
            git,
            worktreeDir: dir,
            suppressUncommittedWarning: true,
          });
          state.worktree = null;
        },
      };
    }
  }

  const leaf = `stage-${randomBytes(16).toString('hex')}`;
  const root = stagedWorkspaceRoot({ projectDir, sessionId }, leaf);
  const staged = await createStagedProject({
    projectDir,
    config,
    role: 'implementer',
    ownedRoot: root,
    pinnedHead,
  });
  const dir = staged.projectDir;
  state.sandboxEnvs.seedImplementerEnv(dir, config, staged.sandboxEnv);
  const rootDirectory = await workspaceDirectoryIdentity(root);
  if (rootDirectory === null) throw retentionError.unavailable();
  state.location = { kind: 'staged-copy', leaf, rootDirectory };
  return {
    dir,
    initialTargetBaseline: staged.targetBaseline,
    discard: async () => staged.cleanup(),
  };
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
    state.openPromise = trackOperation(state, openWorkspace(state, input));
  }
  return state.openPromise;
}

async function openWorkspace(
  state: RunIsolationState,
  input: Parameters<RunIsolation['open']>[0],
): Promise<RunWorkspace> {
  const { config, recorded } = input;
  const { projectDir, sessionId } = state.opts;
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  let seed = await readWorkspaceSeed(ref);
  const strategy = seed?.strategy ?? state.opts.strategy;
  let pinnedHead = seed !== null && 'head' in seed ? (seed.head ?? undefined) : undefined;
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
    if (
      previous.location.kind === 'worktree' &&
      (await resolveWorktreeDir(state, pinnedHead, true)).dir !== dir
    )
      throw retentionError.unavailable();
    await assertWorkspaceIdentity(state, dir);
  } else {
    if (recorded !== undefined) throw retentionError.unavailable();
    const updatedSeed = await pinSeedIfCheckoutChanged(ref, seed);
    if (updatedSeed !== null) {
      pinnedHead = updatedSeed.head;
      seed = updatedSeed;
    }
    let fresh = await createWorkspace(state, config, strategy, pinnedHead);
    const pinned = await pinSeedIfCheckoutChanged(ref, seed);
    if (pinned !== null) {
      pinnedHead = pinned.head;
      await fresh.discard();
      fresh = await createWorkspace(state, config, strategy, pinnedHead);
    }
    ({ dir, initialTargetBaseline } = fresh);
  }
  const { location } = state;
  if (location === undefined) throw retentionError.unavailable();
  const identity = await workspaceDirectoryIdentity(dir);
  if (identity === null) throw retentionError.unavailable();
  state.directory = identity;
  state.owner = workspaceOwner({ sessionId, config });
  state.pinned = pinnedHead !== undefined;
  const { targetBaseline } = await prepareWorktreeAcquisition({
    projectDir,
    sessionId,
    worktreeDir: dir,
    initialTargetBaseline,
    pinned: state.pinned,
  });
  const snapshot = await captureWorkspaceSnapshot(
    dir,
    ref,
    undefined,
    state.pinned ? null : projectDir,
  );
  const keptFiles =
    state.retainedAttempt === null
      ? []
      : await getChangedFilesSinceSnapshot(dir, state.retainedAttempt.snapshot);
  const removeWorkspaceRoot = addWorkspaceRoot(dir);
  const removeGitCeiling = location.kind === 'staged-copy' ? keepGitDiscoveryIn(dir) : undefined;
  state.removeWorkspaceRoot = () => {
    removeGitCeiling?.();
    removeWorkspaceRoot();
  };
  const workspace: RunWorkspace = {
    kind: location.kind,
    projectDir: dir,
    head: location.kind === 'worktree' ? await getCurrentCommitSha(dir) : (pinnedHead ?? null),
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
