import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { publishError } from '../publish/notice.js';
import { buildApplyPartialRecoveryIssue } from '../recovery/builders/apply.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import type { WorkflowContext } from '../types.js';
import { applyBackupDir } from './backup.js';
import { reconcileApplyBackup } from './restore.js';

export function raiseApplyHalt(
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>,
  state: WorkflowState,
  issue: RecoveryIssue,
  setTrackedState?: ((state: WorkflowState) => void) | undefined,
): WorkflowState {
  publishError({
    bus: wctx.bus,
    phase: state.phase,
    message: issue.message,
    safety: {
      category: 'recovery',
      code: issue.reason === 'apply-partial' ? 'apply_partial' : 'apply_conflict',
    },
  });
  return raisePendingRecovery(wctx, state, issue, setTrackedState);
}

/**
 * A process that went away inside Apply leaves its `applying` record and no halt. This raises the
 * apply-partial halt that Retry and Restore answer, from what the checkout holds now.
 */
export async function haltCutApply(
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>,
  state: WorkflowState,
  backupId: string,
  setTrackedState?: ((state: WorkflowState) => void) | undefined,
): Promise<WorkflowState> {
  const reconciliation = await reconcileApplyBackup({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    backupId,
  });
  return raiseApplyHalt(
    wctx,
    state,
    buildApplyPartialRecoveryIssue({
      backupId,
      backupDir: applyBackupDir(wctx.projectDir, wctx.sessionId, backupId),
      reconciliation,
      createdAt: new Date().toISOString(),
    }),
    setTrackedState,
  );
}
