import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import { emit, createTextHandler } from '../events.js';
import { addUsageAndSave, transitionAndEmit, emitPlanApproved } from '../state-ops.js';
import { appendMessage } from '../../../core/state/persistence.js';
import { runApprovalLoop } from '../approval.js';
import {
  drainAndFormat,
  regenerateTasks,
  regenerateTasksIfNeeded,
  regeneratePlanAndTasks,
  type PlanningPhaseOptions,
  type PlanningPhaseResult,
} from './shared.js';

type RewindPending = NonNullable<PlanningPhaseOptions['rewindPending']>;

export async function handleRewindSpec(
  opts: PlanningPhaseOptions,
  rewindPending: RewindPending,
  skipPlanApproval: boolean,
  metadata: SpecMetadata,
  skillsContext: string | undefined,
  state: WorkflowState,
): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const signal = wctx.signal;

  if (rewindPending.comment) {
    appendMessage(projectDir, sessionId, { role: 'user', phase: 'specifying', text: rewindPending.comment }, config.workflow.persistTranscript);
    const current = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
    const { state: drainedState, prefix: drainPrefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    const regenPrompt = drainPrefix + buildRegeneratePrompt('spec', current, rewindPending.comment);
    createTextHandler(callbacks)(`\n[Regenerating spec with feedback: ${rewindPending.comment}]\n`);
    const regenResult = await planner.regenerate(regenPrompt, 'spec', projectDir, {
      onOutput: createTextHandler(callbacks),
    });
    state = addUsageAndSave(projectDir, sessionId, state, 'planner', regenResult.usage, callbacks);
    writeSpecFile(projectDir, sessionId, SPEC_FILE, regenResult.text, metadata);
    emit(projectDir, sessionId, state, 'spec_regenerated', undefined, { comment: rewindPending.comment });
  }

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'SPEC_DONE' }, eventName: 'spec_done', status: 'running', emitData: {} });

  const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
  if (!config.workflow.autoApproveSpec) {
    const specLoop = await runApprovalLoop({ type: 'spec', filePath: specPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = specLoop.state;
    if (specLoop.rejected) return { state, tasks: [], cancelled: true };
  }

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'APPROVE_SPEC' }, eventName: 'spec_approved', status: 'running', emitData: {} });

  const { state: planAndTasksState, tasks } = await regeneratePlanAndTasks(projectDir, sessionId, planner, callbacks, state, metadata, skillsContext);
  state = planAndTasksState;

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'PLAN_DONE', tasks }, eventName: 'plan_done', status: 'running', emitData: { taskCount: tasks.length } });

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
  let finalTasks = tasks;
  if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
    const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = planLoop.state;
    if (planLoop.rejected) return { state, tasks: [], cancelled: true };
    const regen = await regenerateTasksIfNeeded(planLoop.regenerated, projectDir, sessionId, planner, callbacks, state, tasks, metadata);
    state = regen.state;
    finalTasks = regen.tasks;
  }

  state = emitPlanApproved(state, { projectDir, sessionId, callbacks });
  return { state, tasks: finalTasks, cancelled: false };
}

export async function handleRewindPlan(
  opts: PlanningPhaseOptions,
  rewindPending: RewindPending,
  skipPlanApproval: boolean,
  metadata: SpecMetadata,
  state: WorkflowState,
): Promise<PlanningPhaseResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const signal = wctx.signal;

  if (rewindPending.comment) {
    appendMessage(projectDir, sessionId, { role: 'user', phase: 'planning', text: rewindPending.comment }, config.workflow.persistTranscript);
    const current = readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
    const { state: drainedState, prefix: drainPrefix } = drainAndFormat(projectDir, sessionId, state, callbacks);
    state = drainedState;
    const regenPrompt = drainPrefix + buildRegeneratePrompt('plan', current, rewindPending.comment);
    createTextHandler(callbacks)(`\n[Regenerating plan with feedback: ${rewindPending.comment}]\n`);
    const regenResult = await planner.regenerate(regenPrompt, 'plan', projectDir, {
      onOutput: createTextHandler(callbacks),
    });
    state = addUsageAndSave(projectDir, sessionId, state, 'planner', regenResult.usage, callbacks);
    writeSpecFile(projectDir, sessionId, PLAN_FILE, regenResult.text, metadata);
    emit(projectDir, sessionId, state, 'plan_regenerated', undefined, { comment: rewindPending.comment });
  }

  const taskRegen = await regenerateTasks(projectDir, sessionId, planner, callbacks, state, metadata);
  state = taskRegen.state;
  const rewindTasks: Task[] = taskRegen.tasks;

  state = transitionAndEmit({ state, projectDir, sessionId, callbacks, action: { type: 'PLAN_DONE', tasks: rewindTasks }, eventName: 'plan_done', status: 'running', emitData: { taskCount: rewindTasks.length } });

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
  let finalTasks = rewindTasks;
  if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
    const planLoop = await runApprovalLoop({ type: 'plan', filePath: planPath, planner, projectDir, sessionId, callbacks, state, signal, persistTranscript: config.workflow.persistTranscript });
    state = planLoop.state;
    if (planLoop.rejected) return { state, tasks: [], cancelled: true };
    const regen = await regenerateTasksIfNeeded(planLoop.regenerated, projectDir, sessionId, planner, callbacks, state, rewindTasks, metadata);
    state = regen.state;
    finalTasks = regen.tasks;
  }

  state = emitPlanApproved(state, { projectDir, sessionId, callbacks });
  return { state, tasks: finalTasks, cancelled: false };
}
