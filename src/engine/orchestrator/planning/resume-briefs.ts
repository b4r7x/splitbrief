import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError } from '../events.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
import { readPersistedTasks } from './io.js';
import type { PlanningPhaseResult } from './types.js';

export async function resumeBriefsApproval(opts: {
  wctx: PlannerCallbacksContext & { planner: Planner };
  state: WorkflowState;
}): Promise<PlanningPhaseResult> {
  const { wctx, state } = opts;
  const { projectDir, sessionId, bus, planner } = wctx;

  if (state.phase === 'idle') {
    return { disposition: 'terminal', state, outcome: 'rejected' };
  }

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
  const persisted = await readPersistedTasks(tasksFilePath);
  const tasks = persisted.ok ? persisted.tasks : state.tasks;
  if (tasks.length === 0) {
    publishError({
      bus,
      phase: state.phase,
      message: `Cannot resume briefs review: ${TASKS_FILE} is missing from the session directory and the saved state carries no tasks`,
      safety: { category: 'planning', code: 'briefs_not_restorable' },
    });
    return { disposition: 'terminal', state, outcome: 'failed' };
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
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
    ...(wctx.sinks !== undefined && { sinks: wctx.sinks }),
    ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
    ...(wctx.detectedContextLength !== undefined && {
      detectedContextLength: wctx.detectedContextLength,
    }),
  });

  switch (briefsLoop.outcome) {
    case 'accepted':
      return { disposition: 'ready-for-tasks', state: briefsLoop.state, tasks: briefsLoop.tasks };
    case 'rejected':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'rejected' };
    case 'aborted':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'cancelled' };
    case 'failed':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'failed' };
    default: {
      const exhaustive: never = briefsLoop.outcome;
      return exhaustive;
    }
  }
}
