import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import {
  runBriefsApprovalLoop,
  type BriefsApprovalRecoveryBinding,
} from './briefs-approval-loop.js';
import { readPersistedTasks } from './io.js';
import type { PlannerAttemptSettlement } from '../../../core/schemas/brief-recovery/attempt.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type { BriefRecoveryController } from '../../../core/schemas/brief-recovery.js';
import type { PlanningPhaseResult } from './types.js';
import { parkedPlanningResult, planningResultForState } from './handoff.js';

type ResumeBriefsRecoveryController = BriefsApprovalRecoveryBinding['controller'] &
  Pick<BriefRecoveryController, 'settlePlannerAttempt'>;

export type ResumeBriefsRecoveryBinding = Omit<BriefsApprovalRecoveryBinding, 'controller'> & {
  controller: ResumeBriefsRecoveryController;
  projection: BriefRecoveryProjectionV1;
  settle?: PlannerAttemptSettlement | undefined;
};

function statusFromRecovery(
  state: WorkflowState,
  recovery: ResumeBriefsRecoveryBinding | undefined,
): BriefRecoveryProjectionV1['status'] | null {
  if (recovery !== undefined) return recovery.projection.status;
  const saved = state.briefRecovery;
  if (saved === undefined || saved === null) return null;
  return saved.status;
}

function resultForState(
  sessionId: string,
  state: WorkflowState,
  recovery: ResumeBriefsRecoveryBinding | undefined,
  tasks?: readonly Task[],
): PlanningPhaseResult {
  return planningResultForState({
    sessionId,
    state,
    ...(recovery === undefined ? {} : { projection: recovery.projection }),
    ...(tasks === undefined ? {} : { tasks }),
  });
}

export async function resumeBriefsApproval(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  state: WorkflowState;
  qualityValidatedTasks?: Task[] | undefined;
  recovery?: ResumeBriefsRecoveryBinding | undefined;
}): Promise<PlanningPhaseResult> {
  const { wctx, state, qualityValidatedTasks, recovery } = opts;
  const { projectDir, sessionId, bus, planner } = wctx;

  const recoveryStatus = statusFromRecovery(state, recovery);
  if (recoveryStatus === 'rejected') {
    return { disposition: 'terminal', state, outcome: 'rejected' };
  }
  if (recoveryStatus === 'storage-blocked') {
    return parkedPlanningResult(sessionId, state, recovery?.projection);
  }
  if (recovery === undefined) {
    publishWarning({
      bus,
      phase: state.phase,
      message: 'Brief review resume requires the owner-supplied recovery projection.',
      safety: { category: 'planning', code: 'brief_recovery_unavailable', transcriptSafe: true },
    });
    return parkedPlanningResult(sessionId, state);
  }

  let recoveryBinding = recovery;
  if (recovery.settle !== undefined) {
    let recoveryResult: Awaited<ReturnType<typeof recovery.controller.settlePlannerAttempt>>;
    try {
      recoveryResult = await recovery.controller.settlePlannerAttempt(
        recovery.settle,
        recovery.authority,
      );
    } catch (err) {
      publishWarningFromError(
        { bus, phase: state.phase },
        'Settling the planner attempt failed',
        err,
      );
      return parkedPlanningResult(sessionId, state, recovery.projection);
    }
    recoveryBinding = {
      ...recovery,
      projection: recoveryResult.projection,
    };
  }

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
  const persisted = await readPersistedTasks(tasksFilePath);
  const tasks: Task[] = persisted.ok ? persisted.tasks : state.tasks;

  if (tasks.length === 0) {
    publishError({
      bus,
      phase: state.phase,
      message: `Cannot resume briefs review: ${TASKS_FILE} is missing from the session directory and the saved state carries no tasks`,
      safety: { category: 'planning', code: 'briefs_not_restorable', transcriptSafe: true },
    });
    return parkedPlanningResult(sessionId, state, recoveryBinding.projection);
  }

  let briefsLoop: Awaited<ReturnType<typeof runBriefsApprovalLoop>>;
  try {
    briefsLoop = await runBriefsApprovalLoop({
      tasks,
      ...(qualityValidatedTasks !== undefined && { qualityValidatedTasks }),
      planner,
      projectDir,
      sessionId,
      callbacks: wctx.callbacks,
      bus,
      state,
      config: wctx.config,
      metadata: wctx.metadata,
      signal: wctx.signal,
      sinks: wctx.sinks,
      ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
      ...(wctx.detectedContextLength !== undefined && {
        detectedContextLength: wctx.detectedContextLength,
      }),
      recovery: recoveryBinding,
    });
  } catch (err) {
    publishWarningFromError({ bus, phase: state.phase }, 'Brief review resume failed', err);
    return parkedPlanningResult(sessionId, state, recoveryBinding.projection);
  }

  switch (briefsLoop.outcome) {
    case 'failed':
      return parkedPlanningResult(sessionId, briefsLoop.state, recoveryBinding.projection);
    case 'rejected':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'rejected' };
    case 'aborted':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'cancelled' };
    case 'accepted':
      return resultForState(sessionId, briefsLoop.state, recoveryBinding, tasks);
    default: {
      const exhaustive: never = briefsLoop.outcome;
      return exhaustive;
    }
  }
}
