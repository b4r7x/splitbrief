import { join } from 'node:path';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError, publishPlanApproved } from '../events.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { readPersistedTasks } from './io.js';

export async function resumeBriefsApproval(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  state: WorkflowState;
}): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, state } = opts;
  const { projectDir, sessionId, bus, planner } = wctx;

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
    return { state, cancelled: true };
  }

  const briefsLoop = await runBriefsApprovalLoop({
    tasks,
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
  });

  if (briefsLoop.rejected || briefsLoop.aborted)
    return { state: briefsLoop.state, cancelled: true };

  publishPlanApproved(briefsLoop.state, bus);
  return { state: briefsLoop.state, cancelled: false };
}
