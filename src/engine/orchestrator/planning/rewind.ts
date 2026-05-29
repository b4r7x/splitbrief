import { join } from 'node:path';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import { createBusTextHandler, publishPlannerStatus } from '../events.js';
import { addUsageAndSave, transitionAndSave, publishPlanApproved } from '../state-ops.js';
import { appendMessage } from '../../../core/state/persistence.js';
import { runApprovalLoop } from '../approval/approval.js';
import {
  drainAndFormat,
  runBriefQualityGate,
  runBriefsApprovalLoop,
} from './briefs-approval-loop.js';
import { regenerateTasks, regenerateTasksIfNeeded, regeneratePlanAndTasks } from './regen.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';

type RewindPending = NonNullable<PlanningPhaseOptions['rewindPending']>;

async function finishPlanAndBriefsApproval(args: {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  tasks: Task[];
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
}): Promise<PlanningPhaseResult> {
  const { wctx, planner, tasks, skipPlanApproval, metadata } = args;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const signal = wctx.signal;
  let state = args.state;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'PLAN_DONE', tasks });
  publishPlannerStatus(wctx.bus, state, 'running');

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
  let finalTasks = tasks;
  if (!skipPlanApproval && !config.workflow.autoApprovePlan) {
    const planLoop = await runApprovalLoop({
      type: 'plan',
      filePath: planPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      signal,
      persistTranscript: config.workflow.persistTranscript,
    });
    state = planLoop.state;
    if (planLoop.rejected) return { state, tasks: [], cancelled: true };
    const regen = await regenerateTasksIfNeeded({
      regenerated: planLoop.regenerated,
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus: wctx.bus,
      state,
      tasks,
      metadata,
      signal,
    });
    state = regen.state;
    finalTasks = regen.tasks;
  }

  runBriefQualityGate({
    tasks: finalTasks,
    projectDir,
    sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });
  const briefsLoop = await runBriefsApprovalLoop({
    tasks: finalTasks,
    planner,
    projectDir,
    sessionId,
    callbacks,
    bus: wctx.bus,
    state,
    metadata,
    signal,
  });
  state = briefsLoop.state;
  finalTasks = briefsLoop.tasks;
  if (briefsLoop.rejected) return { state, tasks: [], cancelled: true };

  state = publishPlanApproved(state, wctx.bus);
  return { state, tasks: finalTasks, cancelled: false };
}

export async function handleRewindSpec(args: {
  opts: PlanningPhaseOptions;
  rewindPending: RewindPending;
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
  skillsContext: string | undefined;
  state: WorkflowState;
}): Promise<PlanningPhaseResult> {
  const { opts, rewindPending, skipPlanApproval, metadata, skillsContext } = args;
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const signal = wctx.signal;
  let state = args.state;

  if (rewindPending.comment) {
    appendMessage(
      projectDir,
      sessionId,
      { role: 'user', phase: 'specifying', text: rewindPending.comment },
      config.workflow.persistTranscript,
    );
    const current = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
    const { state: drainedState, prefix: drainPrefix } = drainAndFormat(
      projectDir,
      sessionId,
      state,
      wctx.bus,
    );
    state = drainedState;
    const regenPrompt = drainPrefix + buildRegeneratePrompt('spec', current, rewindPending.comment);
    createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
      `\n[Regenerating spec with feedback: ${rewindPending.comment}]\n`,
    );
    const regenResult = await planner.regenerate({
      prompt: regenPrompt,
      artifactType: 'spec',
      projectDir,
      callbacks: {
        onOutput: createBusTextHandler({ bus: wctx.bus, phase: state.phase }),
        signal,
      },
    });
    state = addUsageAndSave(wctx, state, 'planner', regenResult.usage);
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, regenResult.text, metadata);
    wctx.bus.publish({
      type: 'spec_regenerated',
      ts: Date.now(),
      phase: state.phase,
      comment: rewindPending.comment,
    });
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'SPEC_DONE' });
  publishPlannerStatus(wctx.bus, state, 'running');

  const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
  if (!config.workflow.autoApproveSpec) {
    const specLoop = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      signal,
      persistTranscript: config.workflow.persistTranscript,
    });
    state = specLoop.state;
    if (specLoop.rejected) return { state, tasks: [], cancelled: true };
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'APPROVE_SPEC' });
  publishPlannerStatus(wctx.bus, state, 'running');

  const { state: planAndTasksState, tasks } = await regeneratePlanAndTasks({
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus: wctx.bus,
    state,
    metadata,
    skillsContext,
    signal,
  });
  state = planAndTasksState;

  return finishPlanAndBriefsApproval({ wctx, planner, state, tasks, skipPlanApproval, metadata });
}

export async function handleRewindPlan(args: {
  opts: PlanningPhaseOptions;
  rewindPending: RewindPending;
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
  state: WorkflowState;
}): Promise<PlanningPhaseResult> {
  const { opts, rewindPending, skipPlanApproval, metadata } = args;
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const signal = wctx.signal;
  let state = args.state;

  if (rewindPending.comment) {
    appendMessage(
      projectDir,
      sessionId,
      { role: 'user', phase: 'planning', text: rewindPending.comment },
      config.workflow.persistTranscript,
    );
    const current = readSpecFileOrEmpty(projectDir, sessionId, PLAN_FILE);
    const { state: drainedState, prefix: drainPrefix } = drainAndFormat(
      projectDir,
      sessionId,
      state,
      wctx.bus,
    );
    state = drainedState;
    const regenPrompt = drainPrefix + buildRegeneratePrompt('plan', current, rewindPending.comment);
    createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
      `\n[Regenerating plan with feedback: ${rewindPending.comment}]\n`,
    );
    const regenResult = await planner.regenerate({
      prompt: regenPrompt,
      artifactType: 'plan',
      projectDir,
      callbacks: {
        onOutput: createBusTextHandler({ bus: wctx.bus, phase: state.phase }),
        signal,
      },
    });
    state = addUsageAndSave(wctx, state, 'planner', regenResult.usage);
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, regenResult.text, metadata);
    wctx.bus.publish({
      type: 'plan_regenerated',
      ts: Date.now(),
      phase: state.phase,
      comment: rewindPending.comment,
    });
  }

  const taskRegen = await regenerateTasks({
    projectDir,
    sessionId,
    planner,
    callbacks,
    bus: wctx.bus,
    state,
    metadata,
    signal,
  });
  state = taskRegen.state;
  const rewindTasks: Task[] = taskRegen.tasks;

  return finishPlanAndBriefsApproval({
    wctx,
    planner,
    state,
    tasks: rewindTasks,
    skipPlanApproval,
    metadata,
  });
}
