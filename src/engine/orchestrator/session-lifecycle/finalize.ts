import type { Session } from '../../../core/schemas/session.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { CURRENT_STATE_VERSION } from '../../../core/state/machine.js';
import { clearActiveReceipt, type ActiveSessionReceipt } from '../../../core/sessions/lifecycle.js';
import { saveSummary } from '../../../core/sessions/io.js';
import { isResumable } from '../../../core/phases.js';
import { updateStats } from '../../../core/stats/persistence.js';
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

export function shouldPreserveActiveState(state: WorkflowState | null): boolean {
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
    if (
      opts.status === 'complete' &&
      opts.summary.costBreakdown &&
      opts.summary.costBreakdown.isTotalActualCostKnown !== false
    ) {
      try {
        updateStats(opts.projectDir, {
          costBreakdown: opts.summary.costBreakdown,
          totalTasks: opts.summary.totalTasks,
          completedByLocal: opts.summary.completedByLocal,
          escalatedToPlanner: opts.summary.escalatedToPlanner,
          providerCosts: opts.summary.costBreakdown.providerCosts,
        });
      } catch {
        // stats update is best-effort; don't fail session save
      }
    }
    if (!opts.preserveActive) {
      clearActiveReceipt({ projectDir: opts.projectDir, sessionId: opts.sessionId }, opts.active);
    }
  } catch (err) {
    warnError('Failed to save final session', err);
  }
}
