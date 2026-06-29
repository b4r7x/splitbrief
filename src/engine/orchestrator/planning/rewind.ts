import { join } from 'node:path';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import { createBusTextHandler, publishPlannerStatus, publishPlanApproved } from '../events.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/state/persistence.js';
import { runApprovalLoop } from '../approval/loop.js';
import { commitQueueMessagesDrained, formatDrainedMessages, readQueueForPrompt } from '../queue.js';
import { runBriefQualityGate } from './brief-quality-gate.js';
import { runBriefsApprovalLoop } from './briefs-approval-loop.js';
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

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'PLAN_DONE', tasks });
  publishPlannerStatus(wctx.bus, state, 'running');

  const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
  let finalTasks = tasks;
  if (!skipPlanApproval) {
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
      specMetadata: metadata,
      sinks: wctx.sinks,
    });
    state = planLoop.state;
    if (planLoop.rejected || planLoop.aborted) return { state, tasks: [], cancelled: true };
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
      sinks: wctx.sinks,
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
    config,
    metadata,
    signal,
    sinks: wctx.sinks,
  });
  state = briefsLoop.state;
  finalTasks = briefsLoop.tasks;
  if (briefsLoop.rejected || briefsLoop.aborted) return { state, tasks: [], cancelled: true };

  publishPlanApproved(state, wctx.bus);
  return { state, tasks: finalTasks, cancelled: false };
}

export async function handleRewindSpec(args: {
  opts: PlanningPhaseOptions;
  rewindPending: RewindPending;
  skipSpecApproval: boolean;
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
  skillsContext: string | undefined;
  state: WorkflowState;
}): Promise<PlanningPhaseResult> {
  const { opts, rewindPending, skipSpecApproval, skipPlanApproval, metadata, skillsContext } = args;
  const { wctx, planner } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const signal = wctx.signal;
  let state = args.state;

  publishPlannerStatus(wctx.bus, state, 'running');

  if (rewindPending.comment) {
    appendMessage(
      { projectDir, sessionId },
      { role: 'user', phase: 'specifying', text: rewindPending.comment },
      { persistTranscript: config.workflow.persistTranscript },
    );
    const current = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const queued = readQueueForPrompt({ projectDir, sessionId, state });
    state = queued.state;
    const regenPrompt =
      formatDrainedMessages(queued.messages) +
      buildRegeneratePrompt('spec', current, rewindPending.comment);
    createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
      `\n[Regenerating spec with feedback: ${rewindPending.comment}]\n`,
    );
    const regenResult = await planner.regenerate({
      prompt: regenPrompt,
      projectDir,
      callbacks: {
        onOutput: createBusTextHandler(
          { bus: wctx.bus, phase: state.phase },
          { content: 'markdown' },
        ),
        signal,
      },
    });
    state = addUsageAndSave(wctx, state, 'planner', regenResult.usage);
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, regenResult.text, metadata);
    state = commitRewindQueue({ projectDir, sessionId, state, bus: wctx.bus }, queued.messages);
    wctx.bus.publish({
      type: 'spec_regenerated',
      ts: Date.now(),
      phase: state.phase,
      comment: rewindPending.comment,
    });
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'SPEC_DONE' });
  publishPlannerStatus(wctx.bus, state, 'running');

  const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
  if (!skipSpecApproval) {
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
      specMetadata: metadata,
      sinks: wctx.sinks,
    });
    state = specLoop.state;
    if (specLoop.rejected || specLoop.aborted) return { state, tasks: [], cancelled: true };
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'APPROVE_SPEC' });
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
    sinks: wctx.sinks,
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
      { projectDir, sessionId },
      { role: 'user', phase: 'planning', text: rewindPending.comment },
      { persistTranscript: config.workflow.persistTranscript },
    );
    const current = readSpecFileOrEmpty({ projectDir, sessionId }, PLAN_FILE);
    const queued = readQueueForPrompt({ projectDir, sessionId, state });
    state = queued.state;
    const regenPrompt =
      formatDrainedMessages(queued.messages) +
      buildRegeneratePrompt('plan', current, rewindPending.comment);
    createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
      `\n[Regenerating plan with feedback: ${rewindPending.comment}]\n`,
    );
    const regenResult = await planner.regenerate({
      prompt: regenPrompt,
      projectDir,
      callbacks: {
        onOutput: createBusTextHandler(
          { bus: wctx.bus, phase: state.phase },
          { content: 'markdown' },
        ),
        signal,
      },
    });
    state = addUsageAndSave(wctx, state, 'planner', regenResult.usage);
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, regenResult.text, metadata);
    state = commitRewindQueue({ projectDir, sessionId, state, bus: wctx.bus }, queued.messages);
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
    sinks: wctx.sinks,
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

function commitRewindQueue(
  ctx: {
    projectDir: string;
    sessionId: string;
    state: WorkflowState;
    bus: PlannerCallbacksContext['bus'];
  },
  messages: readonly QueuedMessage[],
): WorkflowState {
  if (messages.length === 0) return ctx.state;
  return commitQueueMessagesDrained({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    state: ctx.state,
    messages,
    bus: ctx.bus,
  }).state;
}
