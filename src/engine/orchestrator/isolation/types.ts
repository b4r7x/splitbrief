import type { WorkspaceOwner } from '../../../core/schemas/retained-workspace.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { ChangeDetectionKind } from '../../change-detection.js';
import type { AcquisitionBaseline } from '../approval/file-snapshots/entry.js';

export type IsolationRole = 'planner' | 'implementer';

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

export type RunIsolation = {
  acquire: (opts: {
    role: IsolationRole;
    config: Config;
    writesFiles: 'direct' | 'extracted-code';
    /**
     * A brief's first attempt starts from the project as promoted: whatever an
     * earlier attempt left in the shared worktree that the project never received
     * is discarded before the hand-out, except where the target changed as well.
     * Those conflicting copies stay for recovery. A retry keeps its unfinished
     * work: it iterates on the previous attempt.
     */
    fresh?: boolean | undefined;
    owner?: WorkspaceOwner | undefined;
    resume?: boolean | undefined;
  }) => Promise<IsolatedWorkspace>;
  dispose: () => Promise<void>;
};
