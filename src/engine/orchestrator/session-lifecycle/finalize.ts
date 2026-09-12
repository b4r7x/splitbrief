import type { Session } from '../../../core/schemas/session.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { CURRENT_STATE_VERSION } from '../../../core/state/machine.js';
import {
  clearActiveReceipt,
  type ActiveSessionReceipt,
} from '../../../core/sessions/active-pointer.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { isResumable } from '../../../core/phases.js';
import { warnError } from '../../../lib/warn.js';

export type SaveFinalSessionOpts = {
  projectDir: string;
  sessionId: string;
  active: ActiveSessionReceipt;
  feature: string;
  startTime: number;
  status: Session['status'];
  summary: Summary;
  preserveActive?: boolean | undefined;
};

export function shouldPreserveActiveState(state: WorkflowState | null | undefined): boolean {
  if (!state) return false;
  return state.pendingRecovery !== undefined || isResumable(state);
}

export function saveFinalSession(opts: SaveFinalSessionOpts): void {
  try {
    const session: Session = {
      id: opts.sessionId,
      feature: opts.summary.feature,
      startedAt: opts.startTime,
      completedAt: Date.now(),
      stateVersion: CURRENT_STATE_VERSION,
      status: opts.status,
      summary: opts.summary,
    };
    saveSummary({ projectDir: opts.projectDir, sessionId: opts.sessionId }, session);
    if (!opts.preserveActive) {
      clearActiveReceipt({ projectDir: opts.projectDir, sessionId: opts.sessionId }, opts.active);
    }
  } catch (err) {
    warnError('Failed to save final session', err);
  }
}
