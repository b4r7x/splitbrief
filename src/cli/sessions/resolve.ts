import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { isResumable } from '../../core/phases.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { cliError } from '../errors.js';

export function assertSessionExists(projectDir: string, sessionId: string): void {
  if (!existsSync(sessionDir(projectDir, sessionId))) {
    throw cliError(`session '${sessionId}' not found — run \`splitbrief ps\` to list sessions.`, 1);
  }
}

export function assertResumableState(state: WorkflowState, sessionId: string): void {
  if (state.stateVersion !== CURRENT_STATE_VERSION) {
    throw cliError(
      `session '${sessionId}' state is not current v4 and cannot be resumed before explicit migration.\nStart a new workflow with \`splitbrief start\`.`,
      1,
    );
  }

  if (!isResumable(state)) {
    throw cliError(
      `session '${sessionId}' is in phase "${state.phase}" which cannot be resumed.`,
      1,
    );
  }
}
