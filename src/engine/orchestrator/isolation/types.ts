import type { Config } from '../../../core/schemas/config.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import type {
  RetainedWorkspace,
  WorkspaceOwner,
} from '../../../core/schemas/retained-workspace.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { GitClient } from '../../../lib/git/client.js';
import type { ChangeDetectionKind } from '../../change-detection.js';
import type { AcquisitionBaseline } from '../approval/file-snapshots/entry/baseline.js';
import type { createWorkspaceSandboxEnvs } from './sandbox-env.js';

export type IsolationRole = 'planner' | 'implementer';

/** The brief an attempt builds, with the snapshot of the brief's start. */
export type AttemptBrief = { task: Task; taskStartSnapshot: ChangedFilesSnapshot };

export type AttemptRevertResult = {
  restoredFiles: string[];
  keptPaths: string[];
  savedTo?: string | undefined;
};

export type IsolatedWorkspace = {
  projectDir: string;
  sandboxEnv: NodeJS.ProcessEnv;
  snapshot: ChangedFilesSnapshot;
  cleanup: () => void;
  retain?: (() => Promise<void>) | undefined;
  /**
   * Target inputs the workspace may replace. Reused worktrees retain the old
   * fingerprint where operator edits overlap unfinished work, so a new
   * acquisition cannot authorize overwriting them. A workspace without a
   * baseline promotes nothing.
   */
  targetBaseline: AcquisitionBaseline | undefined;
  /**
   * How a runner working here must have its changes detected. A worktree carries
   * git metadata that would otherwise select the git-status comparator, which
   * cannot see a rewrite of a file the worktree was already dirty in.
   */
  changeDetection?: ChangeDetectionKind | undefined;
};

/** One attempt's hold on the run workspace. */
export type AttemptWorkspace = IsolatedWorkspace & {
  changedFiles: () => Promise<string[]>;
  /** Puts the whole attempt back to its start and publishes its revert row; fails loudly. */
  revert: () => Promise<AttemptRevertResult>;
  /**
   * Puts the given files back to the attempt's start and publishes no row, as the caller names
   * them. `savedTo` is the folder, relative to the project, that holds the bytes a checkout
   * replaced; `briefKept` counts the files a put-back of the brief still acts on afterwards.
   * Fails loudly.
   */
  discard: (files: readonly string[]) => Promise<{
    restoredFiles: string[];
    savedTo?: string | undefined;
    briefKept?: number | undefined;
  }>;
};

export type RunWorkspace = {
  kind: 'worktree' | 'staged-copy' | 'checkout';
  projectDir: string;
  head: string | null;
  keptFiles: string[];
};

export type RunIsolation = {
  /** `recorded` is the kind the run already holds; a run never changes mode once recorded. */
  open: (opts: {
    config: Config;
    recorded?: RunWorkspace['kind'] | undefined;
  }) => Promise<RunWorkspace>;
  acquire: (opts: {
    role: IsolationRole;
    config: Config;
    resume?: boolean | undefined;
    /**
     * The brief the attempt builds, from the snapshot of its start. The revert row names the brief
     * and counts the files a put-back of the brief still acts on.
     */
    brief: AttemptBrief;
  }) => Promise<AttemptWorkspace>;
  dispose: () => Promise<void>;
};

export type RunIsolationOptions = {
  projectDir: string;
  sessionId: string;
  strategy: IsolationStrategy;
  onFallback: (reason: string) => void;
  warningPublisher?: (message: string) => void;
  /** `briefKept` counts the files a put-back of the brief still acts on. */
  infoPublisher?: (row: { message: string; briefKept?: number | undefined }) => void;
};

/**
 * What the open, the attempts, their put-backs and the dispose of one run isolation share, changed
 * in place: each step reads or writes it while another one awaits.
 */
export type RunIsolationState = {
  readonly opts: RunIsolationOptions;
  readonly sandboxEnvs: ReturnType<typeof createWorkspaceSandboxEnvs>;
  // Public retain/acquire calls still in flight. Disposal waits for them, so
  // none of them can write ownership after it completes.
  readonly inFlightOperations: Set<Promise<unknown>>;
  fallbackReported: boolean;
  pinned: boolean;
  /** The run's worktree; `abandoned` when the open fell back after it made the worktree. */
  worktree: { dir: string; git: GitClient; abandoned: boolean } | null;
  nodeModulesExcludeFile: string | null;
  runWorkspace: RunWorkspace | undefined;
  removeWorkspaceRoot: (() => void) | undefined;
  location: RetainedWorkspace['location'] | undefined;
  directory: RetainedWorkspace['directory'] | undefined;
  owner: WorkspaceOwner | undefined;
  retainedAttempt: RetainedWorkspace | null;
  // The `retained` flag of the run's record: a stopped run keeps its workspace whole for Continue.
  retained: boolean;
  ownedWorkspace: IsolatedWorkspace | undefined;
  openPromise: Promise<RunWorkspace> | undefined;
  disposePromise: Promise<void> | undefined;
  acquisitionQueue: Promise<unknown>;
  // A worktree cleanup is asynchronous while its callers are not, so the work is
  // chained here and awaited by everything that reads the worktree afterwards.
  pendingCleanup: Promise<void>;
  // A discard that failed left an attempt's files in the workspace; every later read refuses them.
  cleanupFailure: Error | undefined;
  // Disposal ends public acquisition authority: retain and acquire are refused
  // from here on, and public cleanup must not touch canonical metadata again.
  disposed: boolean;
};
