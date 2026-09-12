import { join } from 'node:path';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import { createBusTextHandler, publishPlannerStatus } from '../events.js';
import { writeAndPublishArtifact } from '../artifact-write.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { runApprovalLoop } from '../approval/loop.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import { regenerateTasks, regenerateTasksIfNeeded, regeneratePlanAndTasks } from './regen.js';
import { handlePlanningFailure } from './failure.js';
import type { PlanningPhaseOptions, PlanningProducerResult } from './types.js';

type RewindPending = NonNullable<PlanningPhaseOptions['rewindPending']>;

async function finishPlanAndBriefsApproval(args: {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  tasks: Task[];
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
}): Promise<PlanningProducerResult> {
  const { wctx, planner, tasks, skipPlanApproval, metadata } = args;
  const { projectDir, sessionId, callbacks } = wctx;
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
      specMetadata: metadata,
      sinks: wctx.sinks,
    });
    state = planLoop.state;
    if (planLoop.rejected || planLoop.aborted) {
      return { disposition: 'terminal', state, outcome: 'rejected' };
    }
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

  return { disposition: 'tasks-ready', state: { ...state, tasks: finalTasks }, tasks: finalTasks };
}

async function regenerateRewoundArtifact(args: {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  target: 'spec' | 'plan';
  current: string;
  comment: string;
  metadata: SpecMetadata;
  queuedMessages: readonly QueuedMessage[];
}): Promise<WorkflowState> {
  const { wctx, planner, target, current, comment, metadata, queuedMessages } = args;
  const { projectDir, sessionId } = wctx;
  let state = args.state;

  const regenPrompt =
    formatDrainedMessages([...queuedMessages]) +
    buildRegeneratePrompt({ artifactType: target, currentContent: current, feedback: comment });
  createBusTextHandler({ bus: wctx.bus, phase: state.phase })(
    `\n[Regenerating ${target} with feedback: ${comment}]\n`,
  );

  const regenResult = await planner.regenerate({
    prompt: regenPrompt,
    projectDir,
    callbacks: { onOutput: () => {}, ...(wctx.signal !== undefined && { signal: wctx.signal }) },
  });
  state = addUsageAndSave(wctx, state, 'planner', regenResult.usage);
  writeAndPublishArtifact({
    projectDir,
    sessionId,
    bus: wctx.bus,
    phase: state.phase,
    kind: target,
    text: regenResult.text,
    metadata,
  });
  return state;
}

export async function handleRewindSpec(args: {
  opts: PlanningPhaseOptions;
  rewindPending: RewindPending;
  skipSpecApproval: boolean;
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
  skillsContext: string | undefined;
  state: WorkflowState;
}): Promise<PlanningProducerResult> {
  const { opts, rewindPending, skipSpecApproval, skipPlanApproval, metadata, skillsContext } = args;
  const { wctx, planner } = opts;
  const { projectDir, sessionId, callbacks } = wctx;
  const signal = wctx.signal;
  let state = args.state;

  publishPlannerStatus(wctx.bus, state, 'running');

  if (rewindPending.comment) {
    appendMessage(
      { projectDir, sessionId },
      { role: 'user', phase: 'specifying', text: rewindPending.comment },
    );
    const current = readSpecFileOrEmpty({ projectDir, sessionId }, SPEC_FILE);
    const queued = readQueueForPrompt({ projectDir, sessionId, state });
    try {
      state = queued.state;
      state = await regenerateRewoundArtifact({
        wctx,
        planner,
        state,
        target: 'spec',
        current,
        comment: rewindPending.comment,
        metadata,
        queuedMessages: queued.messages,
      });
      state = commitQueueMessagesDrained({
        projectDir,
        sessionId,
        state,
        messages: queued.messages,
        bus: wctx.bus,
      }).state;
      wctx.bus.publish({
        type: 'spec_regenerated',
        ts: Date.now(),
        phase: state.phase,
        comment: rewindPending.comment,
      });
    } catch (err) {
      return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
    } finally {
      releaseQueueMessagesForPrompt({ projectDir, sessionId }, queued.messages);
    }
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
      specMetadata: metadata,
      sinks: wctx.sinks,
    });
    state = specLoop.state;
    if (specLoop.rejected || specLoop.aborted) {
      return { disposition: 'terminal', state, outcome: 'rejected' };
    }
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

  return finishPlanAndBriefsApproval({
    wctx,
    planner,
    state,
    tasks,
    skipPlanApproval,
    metadata,
  });
}

export async function handleRewindPlan(args: {
  opts: PlanningPhaseOptions;
  rewindPending: RewindPending;
  skipPlanApproval: boolean;
  metadata: SpecMetadata;
  state: WorkflowState;
}): Promise<PlanningProducerResult> {
  const { opts, rewindPending, skipPlanApproval, metadata } = args;
  const { wctx, planner } = opts;
  const { projectDir, sessionId, callbacks } = wctx;
  const signal = wctx.signal;
  let state = args.state;

  if (rewindPending.comment) {
    appendMessage(
      { projectDir, sessionId },
      { role: 'user', phase: 'planning', text: rewindPending.comment },
    );
    const current = readSpecFileOrEmpty({ projectDir, sessionId }, PLAN_FILE);
    const queued = readQueueForPrompt({ projectDir, sessionId, state });
    try {
      state = queued.state;
      state = await regenerateRewoundArtifact({
        wctx,
        planner,
        state,
        target: 'plan',
        current,
        comment: rewindPending.comment,
        metadata,
        queuedMessages: queued.messages,
      });
      state = commitQueueMessagesDrained({
        projectDir,
        sessionId,
        state,
        messages: queued.messages,
        bus: wctx.bus,
      }).state;
      wctx.bus.publish({
        type: 'plan_regenerated',
        ts: Date.now(),
        phase: state.phase,
        comment: rewindPending.comment,
      });
    } catch (err) {
      return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
    } finally {
      releaseQueueMessagesForPrompt({ projectDir, sessionId }, queued.messages);
    }
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
