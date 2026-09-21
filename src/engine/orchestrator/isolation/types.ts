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
  /**
   * The target project's own files as they stood before the worker was given
   * this workspace. Promotion compares the target against it and never against
   * what the worker's run left behind; a workspace without one promotes nothing.
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
     * is discarded before the hand-out, or the worker reads its own leftovers as
     * finished work. A retry keeps them: it iterates on the previous attempt.
     */
    fresh?: boolean | undefined;
  }) => Promise<IsolatedWorkspace>;
  dispose: () => Promise<void>;
};
