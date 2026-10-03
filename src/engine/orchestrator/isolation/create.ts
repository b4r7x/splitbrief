import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdtemp, realpath, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isInternalGitStatusPath, sessionDir } from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import type {
  RetainedWorkspace,
  WorkspaceOwner,
} from '../../../core/schemas/retained-workspace.js';
import { assertPathConfined, pathConfinementError } from '../../../lib/path-confinement.js';
import { relative } from 'node:path';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { createGitClient, type GitClient } from '../../../lib/git/client.js';
import { getCurrentChangedFiles } from '../../../lib/git/files.js';
import { hasCommits, isGitRepo } from '../../../lib/git/repository.js';
import { warnError } from '../../../lib/warn.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import {
  createRunnerSandboxEnv,
  pruneSandboxNpmCache,
  runnerSandboxIdentity,
  withPrependedPathDirectory,
} from '../../runners/sandbox-env.js';
import { clearBridgedCliState } from '../../runners/sandbox-state-bridge.js';
import { removeSandboxTempDirs } from '../../runners/sandbox-state-paths.js';
import { removeWorktree } from './remove-worktree.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import { readCurrentFileContent } from '../approval/file-snapshots/contents.js';
import {
  captureAcquisitionBaseline,
  type AcquisitionBaseline,
  entriesMatch,
  type FileSnapshotEntry,
  readConfinedEntry,
  readProjectSymlink,
  removeConfinedSymlink,
} from '../approval/file-snapshots/entry.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import { createStagedProject, stripGitignoreBookkeeping } from '../approval/staged-project.js';
import type { IsolationRole, IsolatedWorkspace, RunIsolation } from './types.js';
import { ensureIsolationWorktree, removeNodeModulesExclude } from './worktree.js';
import { prepareWorktreeAcquisition } from './acquisition.js';
import {
  readWorkspaceRecord,
  preserveStagedWorkspace,
  clearWorkspaceRecord,
  retainedDirectoryMatches,
  retainedStagedDirectory,
  retainWorkspaceRecord,
  retentionError,
  stagedWorkspaceRoot,
  workspaceDirectoryIdentity,
} from './retention.js';

const NODE_MODULES = 'node_modules';

// The worktree's parent under the isolation trees root is this repository's
// directory, shared by every session of it, so the removal only succeeds once
// this run's worktree was the last entry: a concurrent session's worktree makes
// it fail with ENOTEMPTY and the directory stays. Without it, the user state
// directory collects one empty directory per repository ever run in.
async function removeEmptyRepositoryRoot(worktreeDir: string): Promise<void> {
  try {
    await rmdir(dirname(worktreeDir));
  } catch {
    return;
  }
}

function gitignoresMatch(a: string | null, b: string | null): boolean {
  return stripGitignoreBookkeeping(a) === stripGitignoreBookkeeping(b);
}

export function createRunIsolation(opts: {
  projectDir: string;
  sessionId: string;
  strategy: IsolationStrategy;
  onFallback: (reason: string) => void;
  onRetained: (dir: string, purpose?: 'continuation' | 'manual-removal') => void;
  warningPublisher?: (message: string) => void;
}): RunIsolation {
  const { projectDir, sessionId, strategy, onFallback, onRetained, warningPublisher } = opts;

  let latchedStrategy: IsolationStrategy = strategy;
  let fallbackReported = false;
  let worktreeDir: string | null = null;
  let worktreeGit: GitClient | null = null;
  let createdWorktreeDir: string | null = null;
  let nodeModulesExcludeFile: string | null = null;
  let worktreeAbandoned = false;
  let retainedWorkspace:
    | {
        workspace: IsolatedWorkspace;
        directory: RetainedWorkspace['directory'] | null;
        location: RetainedWorkspace['location'];
        purpose?: 'continuation' | 'manual-removal';
      }
    | undefined;
  let ownedWorkspace: IsolatedWorkspace | undefined;
  // The worktree's content right after creation and seeding. Seeded files track
  // live project files (the operator's own log of this run, for one), so the
  // dispose scan must only weigh files the run changed on top of this baseline —
  // comparing a stale seed against a project file that moved on would retain a
  // fully promoted worktree forever.
  let seedSnapshot: ChangedFilesSnapshot | null = null;
  let initialTargetBaseline: AcquisitionBaseline | undefined;
  let worktreePromise: Promise<string | null> | null = null;
  // A worktree cleanup is asynchronous while its callers are not, so the work is
  // chained here and awaited by everything that reads the worktree afterwards.
  let pendingCleanup: Promise<void> = Promise.resolve();
  // createRunnerSandboxEnv re-bridges the runner's own host CLI state on every
  // call, so an env is built once per runner and reused for the rest of the run.
  const envMemo = new Map<string, Promise<NodeJS.ProcessEnv>>();
  const resumedSandboxRoots: string[] = [];
  // Disposal ends public acquisition authority: retain and acquire are refused
  // from here on, and public cleanup must not touch canonical metadata again.
  let disposed = false;
  // Public retain/acquire calls still in flight. Disposal waits for them, so
  // none of them can write ownership after it completes.
  const inFlightOperations = new Set<Promise<unknown>>();
  // A retirement that began but has not completed: the workspace's files must
  // survive until its receipt is published and its canonical record is cleared.
  type PendingRetirement = {
    workspace: IsolatedWorkspace;
    owner: WorkspaceOwner;
    directory: RetainedWorkspace['directory'] | null;
    location: RetainedWorkspace['location'];
    resumedStage?: RetainedWorkspace | undefined;
  };
  let pendingRetirement: PendingRetirement | undefined;

  function trackOperation<T>(operation: Promise<T>): Promise<T> {
    inFlightOperations.add(operation);
    const settle = (): void => {
      inFlightOperations.delete(operation);
    };
    void operation.then(settle, settle);
    return operation;
  }

  async function waitForInFlightOperations(): Promise<void> {
    while (inFlightOperations.size > 0) {
      await Promise.allSettled([...inFlightOperations]);
    }
  }

  function reportFallback(reason: string): void {
    if (fallbackReported) return;
    fallbackReported = true;
    onFallback(reason);
    latchedStrategy = 'staged-copy';
  }

  function resolveWorktreeDir(): Promise<string | null> {
    if (worktreePromise === null) {
      worktreePromise = (async (): Promise<string | null> => {
        if (!(await isGitRepo(projectDir))) {
          reportFallback('project is not a git repository');
          return null;
        }
        if (!(await hasCommits(projectDir))) {
          reportFallback('repository has no commits');
          return null;
        }
        const git = createGitClient(projectDir);
        try {
          const targetBeforeCreation = await captureAcquisitionBaseline(projectDir);
          const result = await ensureIsolationWorktree({
            projectDir,
            sessionId,
            git,
            onWorktreeCreated: (path) => {
              createdWorktreeDir = path;
            },
            onNodeModulesExcluded: (file) => {
              nodeModulesExcludeFile = file;
            },
          });
          if (result.kind === 'fallback') {
            worktreeDir = createdWorktreeDir;
            worktreeGit = git;
            worktreeAbandoned = true;
            reportFallback(result.reason);
            return null;
          }
          worktreeGit = git;
          worktreeDir = result.worktreePath;
          if (!result.reused) {
            initialTargetBaseline = targetBeforeCreation;
            seedSnapshot = await getChangedFilesSnapshot(result.worktreePath);
          }
          return result.worktreePath;
        } catch (err) {
          worktreeDir = createdWorktreeDir;
          worktreeGit = git;
          worktreeAbandoned = true;
          reportFallback(toErrorMessage(err));
          return null;
        }
      })();
    }
    return worktreePromise;
  }

  function sandboxEnvFor(
    dir: string,
    role: IsolationRole,
    config: Config,
  ): Promise<NodeJS.ProcessEnv> {
    const runner = config[role];
    // The role reaches createRunnerSandboxEnv so each one bridges into its own
    // <worktree>/.splitbrief/sandbox/<role>: a role's acquisition clears only
    // what it bridged, never the snapshot the other role's memoised env is still
    // pointed at. envMemo is keyed on the runner too, so a task profile
    // overriding config.implementer gets its own rather than the first runner's
    // auth-key allowlist and bridged tool.
    const key = `${dir}\u0000${role}\u0000${runnerSandboxIdentity(runner)}`;
    let env = envMemo.get(key);
    if (env === undefined) {
      env = createRunnerSandboxEnv(dir, runner, role);
      envMemo.set(key, env);
    }
    return env;
  }

  async function workspaceSandboxEnv(input: {
    dir: string;
    role: IsolationRole;
    config: Config;
    sandboxDir?: string | undefined;
  }): Promise<NodeJS.ProcessEnv> {
    const { dir, role, config, sandboxDir = dir } = input;
    const env = await sandboxEnvFor(sandboxDir, role, config);
    let binDir: string;
    try {
      binDir = await realpath(join(dir, NODE_MODULES, '.bin'));
    } catch {
      return env;
    }
    return withPrependedPathDirectory(env, binDir);
  }

  async function resumedSandboxEnv(
    dir: string,
    role: IsolationRole,
    config: Config,
  ): Promise<NodeJS.ProcessEnv> {
    // Re-entry must never refresh credentials through a stopped workspace path.
    const root = await mkdtemp(join(tmpdir(), 'splitbrief-resume-env-'));
    resumedSandboxRoots.push(root);
    return workspaceSandboxEnv({ dir, role, config, sandboxDir: root });
  }

  async function isUnpromoted(worktreePath: string, file: string): Promise<boolean> {
    if (file.endsWith('/')) return false;
    if (isInternalGitStatusPath(file)) return false;
    if (file === '.gitignore')
      return !gitignoresMatch(
        await readCurrentFileContent(worktreePath, file),
        await readCurrentFileContent(projectDir, file),
      );
    return !(await entriesMatch(worktreePath, projectDir, file));
  }

  // Every task in the run shares one worktree, so a cleanup reverts only what
  // this acquisition changed, and only where the project never received it:
  // promoted work stays, because the tasks after it work on top of it. Anything
  // a revert fails to discard is reported by dispose's retention scan.
  function queueWorktreeCleanup(dir: string, snapshot: ChangedFilesSnapshot): void {
    pendingCleanup = pendingCleanup
      .then(async () => {
        const changed = await getChangedFilesSinceSnapshot(dir, snapshot);
        const results = await Promise.all(
          changed.map(async (file) => ((await isUnpromoted(dir, file)) ? file : null)),
        );
        const discarded = results.filter((file): file is string => file !== null);
        // A worker's symlink holds no content to restore, so it goes before the
        // revert. The revert then puts back what the snapshot held at that path,
        // including a project link that the snapshot recorded.
        for (const file of discarded) await removeConfinedSymlink(dir, file);
        await restoreDirtyFilesFromSnapshot(dir, snapshot, discarded);
      })
      .catch((err) => {
        warnError(`Isolation cleanup failed for session ${sessionId} at ${dir}`, err);
      });
  }

  async function ownWorkspace(input: {
    workspace: IsolatedWorkspace;
    owner: WorkspaceOwner | undefined;
    location: RetainedWorkspace['location'];
    resumedStage?: RetainedWorkspace | undefined;
  }): Promise<IsolatedWorkspace> {
    const { workspace, owner, location, resumedStage } = input;
    if (owner === undefined) return workspace;
    // Hoisted function declarations (continueRetention below) do not inherit
    // this body's control-flow narrowing, so the checked owner is pinned here.
    const workspaceOwner: WorkspaceOwner = owner;
    if (disposed) throw retentionError.unavailable();
    const directory = await workspaceDirectoryIdentity(workspace.projectDir);
    if (disposed) throw retentionError.unavailable();
    try {
      await retainWorkspaceRecord(
        { projectDir, sessionId },
        { workspace, owner, location, retained: false },
      );
    } catch (cause) {
      retainedWorkspace = { workspace, directory, location };
      throw retentionError.failed(workspace.projectDir, cause);
    }
    ownedWorkspace = workspace;
    const cleanup = workspace.cleanup;
    let released = false;
    let pending: PendingRetirement | undefined;

    // Preservation precedes every risky step: a failed receipt or clear leaves
    // the tree in place for manual removal instead of authorizing deletion.
    const preserveForRetirement = (): void => {
      retainedWorkspace = {
        workspace,
        directory,
        location,
        ...(resumedStage !== undefined && { purpose: 'manual-removal' as const }),
      };
    };

    // Idempotent: an already-published receipt is accepted through its
    // descriptor, and a cleared record is never cleared twice because release
    // precedes any later call.
    const finishRetirement = (): void => {
      if (resumedStage !== undefined)
        preserveStagedWorkspace({ projectDir, sessionId }, resumedStage);
      clearWorkspaceRecord({ projectDir, sessionId });
      if (retainedWorkspace?.workspace === workspace) retainedWorkspace = undefined;
      if (pendingRetirement === pending) pendingRetirement = undefined;
      pending = undefined;
      ownedWorkspace = undefined;
      released = true;
    };

    const refuseRetention = (): boolean =>
      disposed || released || ownedWorkspace !== workspace || pending !== undefined;

    workspace.cleanup = () => {
      if (released || disposed || ownedWorkspace !== workspace) return;
      // A retirement that failed keeps its pending state and is retried here
      // until it succeeds; continuing failure throws again.
      if (pending !== undefined) {
        if (pending !== pendingRetirement) return;
        try {
          finishRetirement();
        } catch (cause) {
          throw retentionError.failed(workspace.projectDir, cause);
        }
        cleanup();
        return;
      }
      if (retainedWorkspace?.workspace === workspace) return;
      if (resumedStage !== undefined) {
        // A stopped directory can be replaced while this process is away.
        // Preserve its whole tree: pathname checks cannot authorize later deletion.
        preserveForRetirement();
        pending = { workspace, owner, directory, location, resumedStage };
        pendingRetirement = pending;
        try {
          finishRetirement();
        } catch (cause) {
          throw retentionError.failed(workspace.projectDir, cause);
        }
        cleanup();
        return;
      }
      const current = lstatSync(workspace.projectDir, { throwIfNoEntry: false });
      if (
        directory === null ||
        current === undefined ||
        current.isSymbolicLink() ||
        current.dev !== directory.dev ||
        current.ino !== directory.ino ||
        current.birthtimeMs !== directory.birthtimeMs
      )
        return;
      if (location.kind === 'staged-copy') {
        const root = stagedWorkspaceRoot({ projectDir, sessionId }, location.leaf);
        const currentRoot = lstatSync(root, { throwIfNoEntry: false });
        if (
          currentRoot === undefined ||
          currentRoot.isSymbolicLink() ||
          currentRoot.dev !== location.rootDirectory.dev ||
          currentRoot.ino !== location.rootDirectory.ino ||
          currentRoot.birthtimeMs !== location.rootDirectory.birthtimeMs
        )
          return;
        assertPathConfined(relative(projectDir, workspace.projectDir), projectDir);
      }
      if (ownedWorkspace === workspace) {
        preserveForRetirement();
        pending = { workspace, owner, directory, location };
        pendingRetirement = pending;
        try {
          finishRetirement();
        } catch (cause) {
          throw retentionError.failed(workspace.projectDir, cause);
        }
      }
      cleanup();
    };
    workspace.retain = () => {
      // Reject invalid calls before this changes any retention state.
      if (refuseRetention()) return Promise.reject(retentionError.unavailable());
      return trackOperation(continueRetention());
    };

    async function continueRetention(): Promise<void> {
      // Mark ownership first: failed persistence must never turn Stop into deletion.
      retainedWorkspace = { workspace, directory, location };
      try {
        if (
          location.kind === 'staged-copy' &&
          !(await retainedDirectoryMatches(
            { directory: location.rootDirectory },
            stagedWorkspaceRoot({ projectDir, sessionId }, location.leaf),
          ))
        )
          throw retentionError.unavailable();
        if (refuseRetention()) throw retentionError.unavailable();
        if (
          directory === null ||
          canonicalJSON(directory) !==
            canonicalJSON(await workspaceDirectoryIdentity(workspace.projectDir))
        )
          throw retentionError.unavailable();
        if (refuseRetention()) throw retentionError.unavailable();
        await retainWorkspaceRecord(
          { projectDir, sessionId },
          { workspace, owner: workspaceOwner, location },
        );
        retainedWorkspace.purpose = 'continuation';
      } catch (cause) {
        const failure = retentionError.failed(workspace.projectDir, cause);
        warningPublisher?.(failure.message);
        throw failure;
      }
    }

    return workspace;
  }

  function acquire(opts: {
    role: IsolationRole;
    config: Config;
    writesFiles: 'direct' | 'extracted-code';
    fresh?: boolean | undefined;
    owner?: WorkspaceOwner | undefined;
    resume?: boolean | undefined;
  }): Promise<IsolatedWorkspace> {
    // New acquisition authority ends when disposal begins.
    if (disposed) return Promise.reject(retentionError.unavailable());
    return trackOperation(acquireWorkspace(opts));
  }

  async function acquireWorkspace(opts: {
    role: IsolationRole;
    config: Config;
    writesFiles: 'direct' | 'extracted-code';
    fresh?: boolean | undefined;
    owner?: WorkspaceOwner | undefined;
    resume?: boolean | undefined;
  }): Promise<IsolatedWorkspace> {
    const { role, config, writesFiles } = opts;
    const ref = { projectDir, sessionId };
    const previous = opts.owner === undefined ? null : await readWorkspaceRecord(ref);
    if (disposed) throw retentionError.unavailable();
    const sameOwner =
      previous !== null && canonicalJSON(previous.owner) === canonicalJSON(opts.owner);
    const retained = opts.resume === true && opts.fresh !== true && sameOwner ? previous : null;
    if (previous !== null && !previous.retained && opts.resume === true && opts.fresh !== true)
      throw retentionError.unavailable();
    if (retained === null && previous?.location.kind === 'staged-copy') {
      preserveStagedWorkspace(ref, previous);
      onRetained(
        join(sessionDir(projectDir, sessionId), previous.location.leaf, 'workspace'),
        'manual-removal',
      );
    }
    retainedWorkspace = undefined;
    pendingRetirement = undefined;
    if (retained?.location.kind === 'staged-copy' && latchedStrategy === 'worktree')
      reportFallback('resuming retained staged-copy workspace');
    if (retained?.location.kind === 'worktree') latchedStrategy = 'worktree';
    const dir =
      writesFiles === 'extracted-code' || latchedStrategy === 'staged-copy'
        ? null
        : await resolveWorktreeDir();
    if (dir === null) {
      const priorDir = retained === null ? null : retainedStagedDirectory(ref, retained);
      if (
        priorDir !== null &&
        retained !== null &&
        retained.location.kind === 'staged-copy' &&
        (await retainedDirectoryMatches(retained, priorDir)) &&
        (await retainedDirectoryMatches(
          { directory: retained.location.rootDirectory },
          dirname(priorDir),
        ))
      ) {
        for (const file of Object.keys(retained.targetFiles)) assertPathConfined(file, priorDir);
        const sandboxEnv = await resumedSandboxEnv(priorDir, role, config);
        if (
          !(await retainedDirectoryMatches(retained, priorDir)) ||
          !(await retainedDirectoryMatches(
            { directory: retained.location.rootDirectory },
            stagedWorkspaceRoot(ref, retained.location.leaf),
          ))
        )
          throw retentionError.unavailable();
        const workspace: IsolatedWorkspace = {
          projectDir: priorDir,
          sandboxEnv,
          snapshot: retained.snapshot,
          targetBaseline: new Map(Object.entries(retained.targetFiles)),
          changeDetection: 'file-hashes',
          cleanup: () => {},
        };
        return ownWorkspace({
          workspace,
          owner: opts.owner,
          location: retained.location,
          resumedStage: retained,
        });
      }
      if (disposed) throw retentionError.unavailable();
      if (retained?.location.kind === 'staged-copy') {
        preserveStagedWorkspace(ref, retained);
        onRetained(
          join(sessionDir(projectDir, sessionId), retained.location.leaf, 'workspace'),
          'manual-removal',
        );
      }
      const leaf = `stage-${randomBytes(16).toString('hex')}`;
      const root = opts.owner === undefined ? undefined : stagedWorkspaceRoot(ref, leaf);
      const workspace = {
        ...(await createStagedProject({ projectDir, config, role, ownedRoot: root })),
        changeDetection: 'file-hashes' as const,
      };
      if (root === undefined) return workspace;
      const rootDirectory = await workspaceDirectoryIdentity(root);
      if (rootDirectory === null) throw retentionError.unavailable();
      return ownWorkspace({
        workspace,
        owner: opts.owner,
        location: { kind: 'staged-copy', leaf, rootDirectory },
      });
    }
    await pendingCleanup;
    const resumed =
      retained?.location.kind === 'worktree' && (await retainedDirectoryMatches(retained, dir))
        ? retained
        : null;
    const partialFiles =
      resumed === null ? [] : await getChangedFilesSinceSnapshot(dir, resumed.snapshot);
    const discardedOwnerFiles =
      previous?.retained === true &&
      retained === null &&
      previous.location.kind === 'worktree' &&
      (await retainedDirectoryMatches(previous, dir))
        ? await getChangedFilesSinceSnapshot(dir, previous.snapshot)
        : [];
    const { targetBaseline, discarded } = await prepareWorktreeAcquisition({
      projectDir,
      sessionId,
      worktreeDir: dir,
      seedSnapshot,
      initialTargetBaseline,
      fresh:
        opts.fresh === true ||
        (previous !== null && retained === null) ||
        (opts.resume === true && resumed === null),
    });
    initialTargetBaseline = undefined;
    // A changed owner cannot consume conflicting output that safe fresh cleanup preserved.
    for (const file of discardedOwnerFiles) {
      if (await isUnpromoted(dir, file)) throw retentionError.unavailable();
    }
    if (discarded.length > 0) {
      warningPublisher?.(
        `Discarded ${discarded.length} unpromoted change(s) an earlier attempt left in the isolation worktree: ${discarded.join(', ')}`,
      );
    }
    const snapshot = await getChangedFilesSnapshot(dir);
    // What the worktree holds and the project never received is output, never
    // input: its entry is the project's, so it reads as changed and is promoted
    // with this attempt's writes or raised as a promotion conflict.
    if (snapshot.dirtyFileEntries !== undefined) {
      for (const file of Object.keys(snapshot.dirtyFileEntries)) {
        if (!(await isUnpromoted(dir, file))) continue;
        const link = await readProjectSymlink(projectDir, file);
        if (link !== null) {
          delete snapshot.dirtyFileEntries[file];
          snapshot.symlinks = { ...snapshot.symlinks, [file]: link };
          continue;
        }
        let target: FileSnapshotEntry;
        try {
          target = await readConfinedEntry(projectDir, file);
        } catch (err) {
          if (!pathConfinementError.isSymlinkRead(err)) throw err;
          snapshot.dirtyFileEntries[file] = null;
          continue;
        }
        snapshot.dirtyFileEntries[file] =
          target.kind === 'file'
            ? { base64: target.bytes.toString('base64'), mode: target.mode }
            : null;
      }
    }
    // The retained snapshot is the comparison basis this continuation resumes on.
    // A file that was clean at acquisition and committed inside the worktree
    // since then reaches no dirty set, so only the retained HEAD still names it
    // as worker output for approval and promotion.
    if (resumed !== null) snapshot.head = resumed.snapshot.head;
    for (const file of partialFiles) {
      if (resumed?.snapshot.files.includes(file)) {
        if (!snapshot.files.includes(file)) snapshot.files.push(file);
      } else snapshot.files = snapshot.files.filter((entry) => entry !== file);
      if (snapshot.dirtyFileEntries !== undefined) {
        const entry = resumed?.snapshot.dirtyFileEntries?.[file];
        if (entry === undefined) delete snapshot.dirtyFileEntries[file];
        else snapshot.dirtyFileEntries[file] = entry;
      }
      const contents = resumed?.snapshot.dirtyFileContents[file];
      if (contents === undefined) delete snapshot.dirtyFileContents[file];
      else snapshot.dirtyFileContents[file] = contents;
    }
    return ownWorkspace({
      workspace: {
        projectDir: dir,
        sandboxEnv:
          resumed === null
            ? await workspaceSandboxEnv({ dir, role, config })
            : await resumedSandboxEnv(dir, role, config),
        snapshot,
        targetBaseline,
        changeDetection: 'file-hashes',
        cleanup: () => queueWorktreeCleanup(dir, snapshot),
      },
      owner: opts.owner,
      location: { kind: 'worktree' },
    });
  }

  // A reused worktree (a resumed session) has no seed baseline in this process,
  // so every changed file is scanned; retention can only err towards keeping it.
  async function hasUnpromotedWork(worktreePath: string): Promise<boolean> {
    const changed =
      seedSnapshot === null
        ? await getCurrentChangedFiles(worktreePath)
        : await getChangedFilesSinceSnapshot(worktreePath, seedSnapshot);
    for (const file of changed) {
      if (await isUnpromoted(worktreePath, file)) return true;
    }
    return false;
  }

  // Disposal's private finalizer for a retirement public cleanup could not
  // finish: it retries the receipt, then clears the record only while this
  // isolation still owns it. A successor acquisition's record is left alone.
  async function completeRetirement(retirement: PendingRetirement): Promise<void> {
    if (retirement.resumedStage !== undefined)
      preserveStagedWorkspace({ projectDir, sessionId }, retirement.resumedStage);
    if (ownedWorkspace !== retirement.workspace) return;
    const current = await readWorkspaceRecord({ projectDir, sessionId });
    if (
      current !== null &&
      (current.retained ||
        canonicalJSON(current.owner) !== canonicalJSON(retirement.owner) ||
        canonicalJSON(current.location) !== canonicalJSON(retirement.location))
    )
      return;
    clearWorkspaceRecord({ projectDir, sessionId });
  }

  async function dispose(): Promise<void> {
    // Disposal begins: public retain and acquire lose their authority.
    disposed = true;
    try {
      // A call already in flight is waited for before disposal completes, so it
      // can never write ownership afterwards.
      await waitForInFlightOperations();
      await pendingCleanup;
      // The planner never takes the worktree — it runs in the project itself —
      // so the cache that survives a run is the one under the project's sandbox
      // roots, whatever isolation strategy the run ended up on. The worktree's
      // own cache goes with the worktree below.
      await pruneSandboxNpmCache(projectDir);
      removeSandboxTempDirs(projectDir);
      if (pendingRetirement !== undefined) {
        // A retirement public cleanup could not finish must not be reported as
        // completed; disposal retries it and reports a remaining failure.
        const retirement = pendingRetirement;
        try {
          await completeRetirement(retirement);
        } catch (cause) {
          throw retentionError.failed(retirement.workspace.projectDir, cause);
        }
        if (pendingRetirement === retirement) pendingRetirement = undefined;
        if (retainedWorkspace?.workspace === retirement.workspace) retainedWorkspace = undefined;
      }
      if (retainedWorkspace !== undefined) {
        const { workspace, directory, location } = retainedWorkspace;
        let stillOwned = false;
        try {
          stillOwned =
            directory !== null &&
            (await retainedDirectoryMatches({ directory }, workspace.projectDir)) &&
            (location.kind !== 'staged-copy' ||
              (await retainedDirectoryMatches(
                { directory: location.rootDirectory },
                stagedWorkspaceRoot({ projectDir, sessionId }, location.leaf),
              )));
        } catch {
          // An unverifiable location no longer grants permission to remove its files.
        }
        if (!stillOwned) {
          warningPublisher?.(retentionError.unavailable().message);
          return;
        }
        // Identity checks above only diagnose replacement. They cannot make a
        // later pathname deletion safe, so stopped trees keep their sandbox too.
        onRetained(workspace.projectDir, retainedWorkspace.purpose);
        return;
      }
      const dir = worktreeDir;
      if (dir === null || worktreeGit === null) return;
      await clearBridgedCliState(dir);
      removeSandboxTempDirs(dir);
      // A worktree the run fell back from was created before the fallback and was
      // never handed to an implementer, so it holds nothing to salvage and is
      // removed outright rather than scanned for unpromoted work.
      let promotionProven = false;
      if (!worktreeAbandoned) {
        try {
          promotionProven = !(await hasUnpromotedWork(dir));
          if (!promotionProven) {
            await pruneSandboxNpmCache(dir);
            onRetained(dir);
            return;
          }
        } catch (err) {
          // Never delete on a failed scan: the worktree may hold unpromoted work
          // we could not see. Leave it for the next run's marker check to fall
          // back around.
          warnError(
            `Isolation worktree scan failed for session ${sessionId} at ${dir}; retaining it`,
            err,
          );
          return;
        }
      }
      await removeWorktree({
        projectDir,
        slug: basename(dir),
        git: worktreeGit,
        deleteBranch: true,
        worktreeDir: dir,
        ...(warningPublisher !== undefined && { warningPublisher }),
        suppressUncommittedWarning: promotionProven,
      });
      await removeEmptyRepositoryRoot(dir);
    } finally {
      // The entry lives in the repository's shared info/exclude, which the source
      // checkout reads too, so the run owns it only while it is running. It goes
      // last: the retention scan above reads the worktree's git status, and this
      // entry is what keeps the dependency link out of it.
      for (const root of resumedSandboxRoots) {
        await rm(root, { recursive: true, force: true });
        removeSandboxTempDirs(root);
      }
      resumedSandboxRoots.length = 0;
      if (nodeModulesExcludeFile !== null) {
        await removeNodeModulesExclude(nodeModulesExcludeFile, sessionId);
      }
    }
  }

  return { acquire, dispose };
}
