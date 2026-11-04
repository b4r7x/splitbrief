import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { ChangeDetectionKind } from '../../change-detection.js';
import type { AcquisitionBaseline } from '../approval/file-snapshots/entry.js';

export type IsolationRole = 'planner' | 'implementer';

/** The brief an attempt builds, with the snapshot of the brief's start. */
export type AttemptBrief = { task: Task; taskStartSnapshot: ChangedFilesSnapshot };

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
  revert: () => Promise<void>;
  /**
   * Puts the given files back to the attempt's start and publishes no row, as the caller names
   * them. `savedTo` is the folder, relative to the project, that holds the bytes a checkout
   * replaced; `briefKept` counts the files a put-back of the brief still acts on afterwards.
   * Fails loudly.
   */
  discard: (
    files: readonly string[],
  ) => Promise<{ savedTo?: string | undefined; briefKept?: number | undefined }>;
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
