import { randomBytes } from 'node:crypto';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { promoteStagedChanges } from '../approval/staged-project.js';
import { transitionAndSave } from '../state-ops.js';
import type { WorkflowPersistenceContext } from '../types.js';
import { writeApplyBackup } from './backup.js';
import type { ApplyStates } from './states.js';

type WriteApplyResult =
  | { kind: 'changed'; state: WorkflowState; files: string[] }
  | {
      kind: 'partial';
      state: WorkflowState;
      backupId: string;
      written: string[];
      failedFile: string;
      cause: string;
      files: string[];
    }
  | { kind: 'applied'; state: WorkflowState; files: string[] };

export async function writeApply(input: {
  scope: WorkflowPersistenceContext;
  state: WorkflowState;
  states: ApplyStates;
  files: string[];
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<WriteApplyResult> {
  const { scope, states, files, setTrackedState } = input;
  let { state } = input;
  const backupId =
    state.applying?.backupId ?? `apply-${Date.now()}-${randomBytes(8).toString('hex')}`;
  const backup = await writeApplyBackup({
    projectDir: states.projectDir,
    sessionId: scope.sessionId,
    backupId,
    workspaceDir: states.workspaceDir,
    files,
    theirsBaseline: states.theirsBaseline,
  });
  if (backup.kind === 'changed') return { kind: 'changed', state, files: backup.files };

  state = transitionAndSave(scope, state, { type: 'APPLY_START', backupId });
  setTrackedState?.(state);
  const promoted = await promoteStagedChanges({
    targetProjectDir: states.projectDir,
    stagedProjectDir: backup.candidateDir,
    files,
    targetBaseline: states.theirsBaseline,
  });
  const failedFile = promoted.failure?.failedFile ?? promoted.conflictedFiles[0];
  if (failedFile !== undefined) {
    return {
      kind: 'partial',
      state,
      backupId,
      written: promoted.promotedFiles,
      failedFile,
      cause:
        promoted.failure === undefined
          ? 'changed in your checkout during Apply'
          : toErrorMessage(promoted.failure.error),
      files,
    };
  }
  state = transitionAndSave(scope, state, { type: 'APPLY_DONE', files: promoted.promotedFiles });
  setTrackedState?.(state);
  return { kind: 'applied', state, files: promoted.promotedFiles };
}
