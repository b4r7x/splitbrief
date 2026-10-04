import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';
import { deriveRunStatus } from '../../core/sessions/run-status.js';
import { WORKFLOW_STATE_VERSION, type WorkflowState } from '../../core/schemas/workflow.js';
import { cliError } from '../errors.js';

export function assertSessionExists(projectDir: string, sessionId: string): void {
  if (!existsSync(sessionDir(projectDir, sessionId))) {
    throw cliError(`session '${sessionId}' not found — run \`splitbrief ps\` to list sessions.`, 1);
  }
}

export function readyToApplyMessage(sessionId: string): string {
  return `Run ${sessionId} is ready to apply.\nApply with: splitbrief continue ${sessionId} --action apply\nDiscard with: splitbrief continue ${sessionId} --action discard`;
}

export function assertResumableState(state: WorkflowState, sessionId: string): void {
  if (state.stateVersion !== WORKFLOW_STATE_VERSION) {
    throw cliError(
      `session '${sessionId}' state is not current v4 and cannot be resumed before explicit migration.\nStart a new workflow with \`splitbrief start\`.`,
      1,
    );
  }

  const status = deriveRunStatus({ state, liveness: 'not-alive' });
  if (status.kind === 'closed') {
    throw cliError(`Run ${sessionId} is closed (${status.as}); nothing to resume.`, 1);
  }
  if (status.kind === 'ready-to-apply') {
    throw cliError(readyToApplyMessage(sessionId), 1);
  }
}
