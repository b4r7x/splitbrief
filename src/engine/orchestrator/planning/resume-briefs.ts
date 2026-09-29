import { join } from 'node:path';
import {
  blocksBriefsGate,
  resolveApproveLevel,
  resolveMode,
} from '../../../core/config/runtime/resolve.js';
import { admitBriefs } from './run.js';
import { adviseMode } from './mode-advisor.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { TASKS_FILE, sessionDir } from '../../../core/paths.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { publishError, publishWarning } from '../events.js';
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
    return { disposition: 'terminal', state, outcome: 'cancelled' };
  }

  const tasksFilePath = join(sessionDir(projectDir, sessionId), TASKS_FILE);
  const persisted = await readPersistedTasks(tasksFilePath);
  const mode = resolveMode({ config: wctx.config, savedMode: state.mode });
  const approveLevel = resolveApproveLevel({
    mode,
    configApprove: wctx.config.workflow.approve,
    savedApprove: state.approve,
  });
  const briefsGate = blocksBriefsGate(mode, approveLevel);
  if (briefsGate && state.tasks.length === 0 && persisted.ok) {
    publishWarning({
      bus,
      phase: state.phase,
      message:
        'The saved run has no last-announced Task Brief set, so edits made while it was parked cannot be verified. Review tasks.md before approving.',
    });
  }
  // The saved tasks are the last briefs announced at a parked gate. Keep the disk-first
  // restoration path when this run's approval level omits that gate.
  const tasks =
    briefsGate && state.tasks.length > 0
      ? state.tasks
      : persisted.ok
        ? persisted.tasks
        : state.tasks;
  if (tasks.length === 0) {
    publishError({
      bus,
      phase: state.phase,
      message: `Cannot resume briefs review: ${TASKS_FILE} is missing from the session directory and the saved state carries no tasks`,
      safety: { category: 'planning', code: 'briefs_not_restorable' },
    });
    return { disposition: 'terminal', state, outcome: 'failed' };
  }

  if (!briefsGate) {
    return admitBriefs({
      wctx,
      planner,
      state: { ...state, mode, approve: approveLevel },
      tasks,
      mode,
      approveLevel,
      risk: adviseMode([state.feature, state.plannerContext].filter(Boolean).join('\n\n'), mode)
        .risk,
    });
  }

  const briefsLoop = await runBriefsApprovalLoop({
    tasks,
    planner,
    projectDir,
    sessionId,
    callbacks: wctx.callbacks,
    bus,
    state: { ...state, mode, approve: approveLevel },
    config: wctx.config,
    metadata: wctx.metadata,
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
    ...(wctx.sinks !== undefined && { sinks: wctx.sinks }),
    ...(wctx.modelCache !== undefined && { modelCache: wctx.modelCache }),
    ...(wctx.detectedContextLength !== undefined && {
      detectedContextLength: wctx.detectedContextLength,
    }),
    ...(wctx.skillsContext !== undefined && { skillsContext: wctx.skillsContext }),
  });

  switch (briefsLoop.outcome) {
    case 'accepted':
      return { disposition: 'ready-for-tasks', state: briefsLoop.state, tasks: briefsLoop.tasks };
    case 'closed':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'closed' };
    case 'halted':
      return { disposition: 'terminal', state: briefsLoop.state, outcome: 'halted' };
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
