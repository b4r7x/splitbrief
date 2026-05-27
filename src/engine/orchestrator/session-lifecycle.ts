import type { Config } from '../../core/schemas/config.js';
import type { Session } from '../../core/schemas/session.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../events/types.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { clearActive } from '../../core/sessions/lifecycle.js';
import { saveSummary } from '../../core/sessions/io.js';
import { updateStats } from '../../core/stats/persistence.js';
import { warnError } from '../../lib/warn.js';
import { withSignalHandlers } from './signals.js';
import { shutdownWorkflow } from './final-review.js';
import { createClearQueueHandler, createQueueHandler } from './queue.js';
import { createStateSerializer } from './state-serializer.js';
import type { Planner } from '../planners/types.js';
import type { WorkflowSinks } from './types.js';

export type SaveFinalSessionOpts = {
  projectDir: string;
  sessionId: string;
  feature: string;
  startTime: number;
  status: Session['status'];
  summary: Summary;
  preserveActive?: boolean | undefined;
};

export function saveFinalSession(opts: SaveFinalSessionOpts): void {
  try {
    const session: Session = {
      id: opts.sessionId,
      feature: opts.feature,
      startedAt: opts.startTime,
      completedAt: Date.now(),
      stateVersion: CURRENT_STATE_VERSION,
      stateFile: null,
      status: opts.status,
      summary: opts.summary,
    };
    saveSummary({ projectDir: opts.projectDir, sessionId: opts.sessionId }, session);
    if (opts.summary.costBreakdown && opts.summary.costBreakdown.hasSavingsEstimate !== false) {
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
    if (!opts.preserveActive) clearActive(opts.projectDir);
  } catch (err) {
    warnError('Failed to save final session', err);
  }
}

export type WithShutdownHandlersOpts = {
  projectDir: string;
  sessionId: string;
  getTrackedState: () => WorkflowState | undefined;
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined;
};

export async function withShutdownHandlers(
  opts: WithShutdownHandlersOpts,
  fn: () => Promise<void>,
): Promise<{ cancelled: boolean }> {
  const shutdown = () => shutdownWorkflow(opts.projectDir, opts.sessionId, opts.getTrackedState, opts.getCurrentTask);
  return withSignalHandlers(shutdown, fn);
}

export type InstallQueueHandlerOpts = {
  projectDir: string;
  sessionId: string;
  sinks: WorkflowSinks;
  getTrackedState: () => WorkflowState | undefined;
  setTrackedState: (s: WorkflowState) => void;
  bus: EventBus;
  config: Config;
  planner: Planner;
};

export function installQueueHandler(opts: InstallQueueHandlerOpts): void {
  const serialize = createStateSerializer();
  opts.sinks.setQueueHandler(createQueueHandler(
    opts.projectDir,
    opts.sessionId,
    opts.getTrackedState,
    opts.setTrackedState,
    opts.bus,
    opts.config.workflow.persistTranscript,
    opts.planner,
    serialize,
  ));
  opts.sinks.setClearQueueHandler?.(createClearQueueHandler(
    opts.projectDir,
    opts.sessionId,
    opts.getTrackedState,
    opts.setTrackedState,
    opts.bus,
  ));
}
