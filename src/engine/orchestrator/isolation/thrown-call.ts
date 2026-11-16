import { sessionError } from '../../../core/sessions/errors.js';
import { isAbortError } from '../../../utils/abort.js';
import { workflowCancelledReasonFromSignal } from '../../events/workflow-cancel.js';
import { retentionError } from './retention.js';
import type { IsolatedWorkspace } from './types.js';

export function isResumableWorkspaceStop(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && workflowCancelledReasonFromSignal(signal) === undefined;
}

/**
 * Settles the workspace of a BUILD call that threw. A stop takes the call's files back, and a stop
 * the run can resume keeps them for it. A failed save of the run takes them back too, because the
 * run stops with no consult. A call that failed keeps them for the consult.
 */
export async function settleThrownCall(
  workspace: IsolatedWorkspace,
  signal: AbortSignal | undefined,
  err: unknown,
): Promise<void> {
  if (isAbortError(err) && isResumableWorkspaceStop(signal)) await workspace.retain?.();
  else if (
    isAbortError(err) ||
    sessionError.isLocalSaveFailure(err) ||
    (signal?.aborted && !retentionError.isFailed(err))
  )
    workspace.cleanup();
}
