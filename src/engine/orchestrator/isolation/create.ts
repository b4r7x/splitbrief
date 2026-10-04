import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { Config } from '../../../core/schemas/config.js';
import type {
  RetainedWorkspace,
  WorkspaceOwner,
} from '../../../core/schemas/retained-workspace.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import { createGitClient, type GitClient } from '../../../lib/git/client.js';
import { getCurrentCommitSha } from '../../../lib/git/refs.js';
import { getGitCommonDir, hasCommits, isGitRepo } from '../../../lib/git/repository.js';
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
import { collectTrackedFiles } from '../../snapshots/files.js';
import { removeWorktree } from './remove-worktree.js';
import { attemptCleanupError } from './errors.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from '../approval/file-snapshots/capture.js';
import {
  captureAcquisitionBaseline,
  type AcquisitionBaseline,
  readConfinedEntry,
  removeConfinedSymlink,
  writeConfinedEntry,
} from '../approval/file-snapshots/entry.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import { createStagedProject } from '../approval/staged-project.js';
import type {
  AttemptWorkspace,
  IsolationRole,
  IsolatedWorkspace,
  RunIsolation,
  RunWorkspace,
} from './types.js';
import { ensureIsolationWorktree, removeNodeModulesExclude } from './worktree.js';
import { resolveConfinedIsolationWorktreePath } from './path.js';
import { prepareWorktreeAcquisition } from './acquisition.js';
import {
  captureStagedSnapshot,
  changedStagedFiles,
  restoreStagedFiles,
} from './staged-snapshot.js';
import {
  readWorkspaceRecord,
  retainedDirectoryMatches,
  retainedStagedDirectory,
  retainWorkspaceRecord,
  retentionError,
  stagedWorkspaceRoot,
  workspaceDirectoryIdentity,
  workspaceOwner,
} from './retention.js';

const NODE_MODULES = 'node_modules';

export function createRunIsolation(opts: {
  projectDir: string;
  sessionId: string;
  strategy: IsolationStrategy;
  onFallback: (reason: string) => void;
  onRetained: (dir: string) => void;
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
  let runWorkspace: RunWorkspace | undefined;
  let location: RetainedWorkspace['location'] | undefined;
  let directory: RetainedWorkspace['directory'] | undefined;
  let owner: WorkspaceOwner | undefined;
  let retainedAttempt: RetainedWorkspace | null = null;
  // Whether the record last saved holds a retained attempt; disposal reports it without reading
  // the record again, so an unreadable record cannot fail the stop that keeps the bytes.
  let recordRetained = false;
  let ownedWorkspace: IsolatedWorkspace | undefined;
  let openPromise: Promise<RunWorkspace> | undefined;
  let disposePromise: Promise<void> | undefined;
  let acquisitionQueue: Promise<unknown> = Promise.resolve();
  let initialTargetBaseline: AcquisitionBaseline | undefined;
  let worktreePromise: Promise<string | null> | null = null;
  // A worktree cleanup is asynchronous while its callers are not, so the work is
  // chained here and awaited by everything that reads the worktree afterwards.
  let pendingCleanup: Promise<void> = Promise.resolve();
  // A discard that failed left an attempt's files in the workspace; every later read refuses them.
  let cleanupFailure: Error | undefined;
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

  async function assertWorkspaceIdentity(dir: string): Promise<void> {
    if (
      directory === undefined ||
      location === undefined ||
      !(await retainedDirectoryMatches({ directory }, dir)) ||
      (location.kind === 'staged-copy' &&
        !(await retainedDirectoryMatches(
          { directory: location.rootDirectory },
          stagedWorkspaceRoot({ projectDir, sessionId }, location.leaf),
        )))
    )
      throw retentionError.unavailable();
  }

  async function saveRecord(workspace: IsolatedWorkspace, retained: boolean): Promise<void> {
    if (owner === undefined || location === undefined) throw retentionError.unavailable();
    await retainWorkspaceRecord(
      { projectDir, sessionId },
      { workspace, owner, location, retained },
    );
    recordRetained = retained;
  }

  function open(input: { config: Config }): Promise<RunWorkspace> {
    if (disposed) return Promise.reject(retentionError.unavailable());
    if (openPromise === undefined) openPromise = trackOperation(openWorkspace(input.config));
    return openPromise;
  }

  async function openWorkspace(config: Config): Promise<RunWorkspace> {
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const previous = await readWorkspaceRecord(ref);
    if (disposed) throw retentionError.unavailable();
    let dir: string | null = null;
    if (previous !== null) {
      if (previous.location.kind === 'staged-copy') {
        dir = retainedStagedDirectory(ref, previous);
        if (strategy === 'worktree') reportFallback('resuming retained staged-copy workspace');
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
      location = previous.location;
      directory = previous.directory;
      if (previous.retained) retainedAttempt = previous;
      if (previous.location.kind === 'worktree') {
        latchedStrategy = 'worktree';
        if ((await resolveWorktreeDir()) !== dir) throw retentionError.unavailable();
      }
      await assertWorkspaceIdentity(dir);
    } else if (latchedStrategy === 'worktree') {
      dir = await resolveWorktreeDir();
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
      envMemo.set(
        `${dir}\u0000implementer\u0000${runnerSandboxIdentity(config.implementer)}`,
        Promise.resolve(staged.sandboxEnv),
      );
      const rootDirectory = await workspaceDirectoryIdentity(root);
      if (rootDirectory === null) throw retentionError.unavailable();
      location = { kind: 'staged-copy', leaf, rootDirectory };
    } else if (location === undefined) {
      location = { kind: 'worktree' };
    }
    const identity = await workspaceDirectoryIdentity(dir);
    if (identity === null) throw retentionError.unavailable();
    directory = identity;
    owner = workspaceOwner({ sessionId, config });
    const { targetBaseline } = await prepareWorktreeAcquisition({
      projectDir,
      sessionId,
      worktreeDir: dir,
      initialTargetBaseline,
    });
    initialTargetBaseline = undefined;
    const snapshot =
      location.kind === 'worktree'
        ? await getChangedFilesSnapshot(dir)
        : await captureStagedSnapshot(dir, projectDir);
    const keptFiles =
      retainedAttempt === null ? [] : await changedAttemptFiles(dir, retainedAttempt.snapshot);
    runWorkspace = {
      kind: location.kind,
      projectDir: dir,
      head: location.kind === 'worktree' ? await getCurrentCommitSha(dir) : null,
      keptFiles,
    };
    if (disposed) throw retentionError.unavailable();
    await saveRecord(
      {
        projectDir: dir,
        sandboxEnv: {},
        snapshot: retainedAttempt?.snapshot ?? snapshot,
        targetBaseline,
        cleanup: () => {},
      },
      retainedAttempt !== null,
    );
    return runWorkspace;
  }

  function changedAttemptFiles(dir: string, snapshot: ChangedFilesSnapshot): Promise<string[]> {
    return location?.kind === 'staged-copy'
      ? changedStagedFiles(dir, snapshot)
      : getChangedFilesSinceSnapshot(dir, snapshot);
  }

  async function revertAttempt(
    dir: string,
    snapshot: ChangedFilesSnapshot,
    files?: readonly string[],
  ): Promise<void> {
    await assertWorkspaceIdentity(dir);
    const changed = await changedAttemptFiles(dir, snapshot);
    const selected = files === undefined ? changed : changed.filter((file) => files.includes(file));
    if (location?.kind === 'worktree') {
      for (const file of selected) await removeConfinedSymlink(dir, file);
      await restoreDirtyFilesFromSnapshot(dir, snapshot, selected);
    } else {
      await restoreStagedFiles(dir, snapshot, selected);
    }
  }

  function queueCleanup(
    dir: string,
    snapshot: ChangedFilesSnapshot,
    files?: readonly string[],
  ): void {
    pendingCleanup = pendingCleanup
      .then(() => revertAttempt(dir, snapshot, files))
      .catch((err) => {
        cleanupFailure ??= attemptCleanupError.failed(dir, err);
        warnError(`Isolation cleanup failed for session ${sessionId} at ${dir}`, err);
      });
  }

  async function settledCleanup(): Promise<void> {
    await pendingCleanup;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }

  async function captureAttemptBase(dir: string): Promise<void> {
    const attemptBase = join(dirname(dir), 'attempt-base');
    await rm(attemptBase, { recursive: true, force: true });
    await mkdir(attemptBase);
    for (const file of await collectTrackedFiles(dir, { ignoreProjectDir: projectDir })) {
      await writeConfinedEntry(attemptBase, file, await readConfinedEntry(dir, file));
    }
  }

  function acquire(input: Parameters<RunIsolation['acquire']>[0]): Promise<AttemptWorkspace> {
    if (disposed) return Promise.reject(retentionError.unavailable());
    const operation = acquisitionQueue.then(() => acquireWorkspace(input));
    acquisitionQueue = operation.catch(() => undefined);
    return trackOperation(operation);
  }

  async function acquireWorkspace(
    input: Parameters<RunIsolation['acquire']>[0],
  ): Promise<AttemptWorkspace> {
    const opened = await open({ config: input.config });
    const dir = opened.projectDir;
    await settledCleanup();
    await assertWorkspaceIdentity(dir);
    if (disposed) throw retentionError.unavailable();
    const previous = retainedAttempt ?? (await readWorkspaceRecord({ projectDir, sessionId }));
    const retained = previous?.retained === true ? previous : null;
    if (retained !== null && input.resume !== true) await revertAttempt(dir, retained.snapshot);
    const resumed = retained !== null && input.resume === true;
    const { targetBaseline } = await prepareWorktreeAcquisition({
      projectDir,
      sessionId,
      worktreeDir: dir,
      initialTargetBaseline: undefined,
    });
    const snapshot = resumed
      ? retained.snapshot
      : opened.kind === 'worktree'
        ? await getChangedFilesSnapshot(dir)
        : await captureStagedSnapshot(dir, projectDir);
    if (opened.kind === 'staged-copy' && !resumed) await captureAttemptBase(dir);
    const sandboxEnv = resumed
      ? await resumedSandboxEnv(dir, input.role, input.config)
      : await workspaceSandboxEnv({ dir, role: input.role, config: input.config });
    await assertWorkspaceIdentity(dir);
    if (disposed) throw retentionError.unavailable();
    let preserved = false;
    const workspace: AttemptWorkspace = {
      projectDir: dir,
      sandboxEnv,
      snapshot,
      targetBaseline,
      changeDetection: 'file-hashes',
      changedFiles: () => changedAttemptFiles(dir, snapshot),
      cleanup: (files) => {
        if (disposed || preserved || ownedWorkspace !== workspace) return;
        queueCleanup(dir, snapshot, files);
      },
      revert: async (files) => {
        if (disposed || ownedWorkspace !== workspace) throw retentionError.unavailable();
        await settledCleanup();
        await revertAttempt(dir, snapshot, files);
      },
      retain: () => {
        if (disposed || ownedWorkspace !== workspace)
          return Promise.reject(retentionError.unavailable());
        preserved = true;
        return trackOperation(
          (async () => {
            try {
              await assertWorkspaceIdentity(dir);
              if (disposed || ownedWorkspace !== workspace) throw retentionError.unavailable();
              await saveRecord(workspace, true);
            } catch (cause) {
              const failure = retentionError.failed(dir, cause);
              warningPublisher?.(failure.message);
              throw failure;
            }
          })(),
        );
      },
    };
    await saveRecord(workspace, false);
    retainedAttempt = null;
    ownedWorkspace = workspace;
    return workspace;
  }

  function dispose(): Promise<void> {
    if (disposePromise === undefined) {
      disposed = true;
      disposePromise = disposeWorkspace();
    }
    return disposePromise;
  }

  async function disposeWorkspace(): Promise<void> {
    try {
      await waitForInFlightOperations();
      await pendingCleanup;
      await pruneSandboxNpmCache(projectDir);
      removeSandboxTempDirs(projectDir);
      if (worktreeDir !== null && worktreeGit !== null) {
        await clearBridgedCliState(worktreeDir);
        removeSandboxTempDirs(worktreeDir);
        if (worktreeAbandoned) {
          await removeWorktree({
            projectDir,
            slug: basename(worktreeDir),
            git: worktreeGit,
            deleteBranch: true,
            worktreeDir,
            ...(warningPublisher !== undefined && { warningPublisher }),
            suppressUncommittedWarning: true,
          });
        }
      }
      if (runWorkspace !== undefined && recordRetained) onRetained(runWorkspace.projectDir);
    } finally {
      for (const root of resumedSandboxRoots) {
        await rm(root, { recursive: true, force: true });
        removeSandboxTempDirs(root);
      }
      resumedSandboxRoots.length = 0;
      if (nodeModulesExcludeFile !== null)
        await removeNodeModulesExclude(nodeModulesExcludeFile, sessionId);
    }
  }

  return { open, acquire, dispose };
}
