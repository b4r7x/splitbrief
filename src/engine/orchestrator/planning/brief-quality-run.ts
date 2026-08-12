import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import type { PlannerCallbacksContext } from '../types.js';
import { handlePlanningFailure } from './failure.js';
import { prepareBriefQuality } from './brief-quality-preparation.js';
import type { PlanningPhaseResult } from './types.js';

type PreparationOptions = Parameters<typeof prepareBriefQuality>[0];

export type BriefQualityRunOptions = Pick<PreparationOptions, 'tasks' | 'state' | 'planner'> & {
  wctx: PlannerCallbacksContext;
  queuedMessages?: PreparationOptions['queuedMessages'];
};

export type BriefQualityRunResult =
  | {
      ok: true;
      state: WorkflowState;
      tasks: Task[];
      report: BriefQualityReport;
    }
  | {
      ok: false;
      result: PlanningPhaseResult;
    };

export async function runBriefQuality(
  opts: BriefQualityRunOptions,
): Promise<BriefQualityRunResult> {
  const { wctx } = opts;
  const preparation = {
    tasks: opts.tasks,
    state: opts.state,
    planner: opts.planner,
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    callbacks: wctx.callbacks,
    bus: wctx.bus,
    metadata: wctx.metadata,
    ...(wctx.signal !== undefined ? { signal: wctx.signal } : {}),
    ...(wctx.sinks !== undefined ? { sinks: wctx.sinks } : {}),
    ...(opts.queuedMessages !== undefined ? { queuedMessages: opts.queuedMessages } : {}),
  } satisfies PreparationOptions;

  try {
    const prepared = await prepareBriefQuality(preparation);
    if (!prepared.ok) {
      return {
        ok: false,
        result: handlePlanningFailure({
          err: prepared.error,
          projectDir: wctx.projectDir,
          sessionId: wctx.sessionId,
          state: prepared.state,
          wctx,
        }),
      };
    }

    return {
      ok: true,
      state: prepared.state,
      tasks: prepared.tasks,
      report: prepared.report,
    };
  } catch (err) {
    return {
      ok: false,
      result: handlePlanningFailure({
        err,
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
        state: opts.state,
        wctx,
      }),
    };
  }
}
