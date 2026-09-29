import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { Planner } from '../../planners/types.js';
import type { PlannerCallbacksContext } from '../types.js';
import { readSpecFileOrEmpty, type SpecMetadata } from '../../../core/paths-io.js';
import {
  BRIEF_QUALITY_FILE,
  PLAN_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { buildRegeneratePrompt } from '../../spec/prompts/plan.js';
import { createBusTextHandler, publishPlannerStatus } from '../events.js';
import { writeAndPublishArtifact } from '../artifact-write.js';
import { addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { resetDriftChainState } from '../drift/chain-state.js';
import {
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueueMessagesForPrompt,
} from '../queue/drain.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import { handlePlanningFailure } from './failure.js';
import { invalidateFrom } from './invalidate.js';
import { runPlanningSteps } from './steps.js';
import { withRewindFeedback } from './rewind-feedback.js';
import type { PlanningPhaseOptions, PlanningProducerResult } from './types.js';

type RewindPending = NonNullable<PlanningPhaseOptions['rewindPending']>;

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

/**
 * `/revise-spec` and `/revise-plan`: the named artifact is rewritten from the
 * operator's comment, everything downstream of it is invalidated, and the step
 * loop re-runs exactly the calls that lost their artifact.
 */
export async function runRewindPlanning(
  opts: PlanningPhaseOptions,
  rewindPending: RewindPending,
): Promise<PlanningProducerResult> {
  const { wctx, planner } = opts;
  const { projectDir, sessionId, metadata } = wctx;
  const ref = { projectDir, sessionId };
  let state = transitionAndSave(ref, opts.state, { type: 'CLEAR_REWIND_PENDING' });
  try {
    resetDriftChainState(ref);
  } catch {
    // non-fatal: rewind continues even if chain state reset fails
  }
  publishPlannerStatus(wctx.bus, state, 'running');

  // Quick mode has one artifact and no documents to revise: the comment rides the
  // feature and the briefs are compiled again. The report that measured the removed
  // briefs goes with them.
  if ((state.mode ?? 'standard') === 'quick') {
    const dir = sessionDir(projectDir, sessionId);
    rmSync(join(dir, TASKS_FILE), { force: true });
    rmSync(join(dir, BRIEF_QUALITY_FILE), { force: true });
    return runPlanningSteps({
      ...opts,
      state,
      feature: withRewindFeedback(opts.feature, rewindPending),
    });
  }

  const target = rewindPending.target;
  const comment = rewindPending.comment;
  if (comment) {
    if (opts.beforeFirstCall && !(await opts.beforeFirstCall())) {
      return { disposition: 'terminal', state, outcome: 'cancelled' };
    }
    appendMessage(ref, {
      role: 'user',
      phase: target === 'spec' ? 'specifying' : 'planning',
      text: comment,
    });
    const current = readSpecFileOrEmpty(ref, target === 'spec' ? SPEC_FILE : PLAN_FILE);
    const queued = readQueueForPrompt({ projectDir, sessionId, state });
    try {
      state = queued.state;
      state = await regenerateRewoundArtifact({
        wctx,
        planner,
        state,
        target,
        current,
        comment,
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
        type: target === 'spec' ? 'spec_regenerated' : 'plan_regenerated',
        ts: Date.now(),
        phase: state.phase,
        comment,
      });
    } catch (err) {
      return handlePlanningFailure({ err, projectDir, sessionId, state, wctx });
    } finally {
      releaseQueueMessagesForPrompt(ref, queued.messages);
    }
  }

  invalidateFrom(ref, target);
  return runPlanningSteps({
    ...opts,
    state,
    startAt: target,
    // A plan rewind never re-opens the spec gate: the spec it was approved
    // against has not changed.
    ...(target === 'plan' ? { passedGates: ['spec' as const] } : {}),
  });
}
