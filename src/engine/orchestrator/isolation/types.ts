import type { Config } from '../../../core/schemas/config.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { ChangeDetectionKind } from '../../change-detection.js';
import type { AcquisitionBaseline } from '../approval/file-snapshots/entry.js';

export type IsolationRole = 'planner' | 'implementer';

export type IsolatedWorkspace = {
  projectDir: string;
  sandboxEnv: NodeJS.ProcessEnv;
  snapshot: ChangedFilesSnapshot;
  cleanup: (files?: readonly string[]) => void;
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
  /** Puts the given files back to the attempt's start inside the workspace; fails loudly. */
  revert: (files: readonly string[]) => Promise<void>;
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
  }) => Promise<AttemptWorkspace>;
  dispose: () => Promise<void>;
};
