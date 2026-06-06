import { readActive } from '../../core/sessions/lifecycle.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { isResumable } from '../../core/phases.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { findSingleRunningSession, type ScanRunningSessionsDeps } from './single-running.js';
import { cliError } from '../errors.js';

export function resolveSessionOrThrow(projectDir: string, sessionOpt: string | undefined): string {
  const sessionId = sessionOpt ?? readActive(projectDir);
  if (!sessionId) throw cliError('No active session. Pass --session <id>.', 1);
  return sessionId;
}

export async function resolveRunningSession(
  projectDir: string,
  deps: ScanRunningSessionsDeps,
): Promise<string> {
  const result = await findSingleRunningSession(projectDir, deps);
  if (result.kind === 'single') return result.id;
  if (result.kind === 'none') {
    throw cliError('no running sessions found; pass <session-id> explicitly', 1);
  }
  throw cliError(
    `multiple running sessions (${result.ids.join(', ')}); pass <session-id> explicitly`,
    1,
  );
}

export function assertResumableState(state: WorkflowState, sessionId: string): void {
  if (state.stateVersion < CURRENT_STATE_VERSION) {
    throw cliError(
      `session '${sessionId}' state is from an older version and cannot be resumed.\nStart a new workflow with \`diptych start\`.`,
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
