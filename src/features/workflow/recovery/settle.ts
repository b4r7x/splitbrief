import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { ApplyRecoveryActionResult } from '../../../engine/orchestrator/recovery/actions/types.js';
import { filesStillOnDiskSuffix } from '../../../engine/orchestrator/run/close.js';
import { parsePreparedConfig } from '../../../engine/runners/prepare-execution/prepared.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import type { PendingRecoveryResult, RecoveryDriverState } from './types.js';

/** The prompt's result for an applied action, or `null` when the halt stays on the panel. */
export function settle(
  driver: RecoveryDriverState,
  result: ApplyRecoveryActionResult,
  comment?: UserMessageInput,
  steer?: UserMessageInput,
): PendingRecoveryResult | null {
  const { prepared, setInlineResume } = driver;
  const { projectDir, sessionId } = prepared.session.ref;
  setInlineResume(result.state);

  if (!result.ok) {
    feedbackStore.setError(result.message);
    // The engine must stay parked on this halt. Returning shouldRun here re-enters the
    // workflow with the same pending issue before the operator can choose another action.
    return null;
  }

  feedbackStore.reset();

  const status = deriveRunStatus({
    state: result.state,
    liveness: 'not-alive',
    reviewNone: false,
  });
  if (status.kind === 'closed') {
    // The close is on the state; the run loop finalizes the session from it —
    // one summary, one receipt release, through the same path every other
    // ending takes.
    feedbackStore.setMessage(
      `Run ${status.as === 'complete' ? 'closed' : 'ended'}.${filesStillOnDiskSuffix({ projectDir, sessionId }, result.state)}`,
    );
    return { shouldRun: false, state: result.state };
  }

  const continuationSteer =
    result.status === 'retry-current-task'
      ? steer
      : result.status === 'continued' && !result.correctionRecorded
        ? comment
        : undefined;
  const steered =
    continuationSteer !== undefined && continuationSteer.text.trim() !== ''
      ? { steer: continuationSteer }
      : {};
  const updatedPreparation =
    result.currentConfig === undefined
      ? {}
      : { prepared: { ...prepared, config: parsePreparedConfig(result.currentConfig) } };
  return {
    shouldRun: true,
    state: result.state,
    ...updatedPreparation,
    ...steered,
    ...(result.status === 'continued' && result.correctionRecorded
      ? { correctionTaken: true }
      : {}),
  };
}
