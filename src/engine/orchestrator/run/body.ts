import { seatForRunningCall } from '../../../core/runners/seat-roles.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { createInitialState } from '../../../core/state/machine.js';
import { killProcessScope } from '../../../lib/process/registry.js';
import { warnError } from '../../../lib/warn.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { assertNever } from '../../../utils/type-guards.js';
import { createSteeringPort } from '../../calls/steering.js';
import { retentionError } from '../isolation/retention.js';
import { publishError } from '../publish/notice.js';
import { reopenSessionRecord } from '../session-lifecycle/finalize.js';
import { installQueueHandler } from '../session-lifecycle/install-queue.js';
import { readWorkflowStateHead } from '../state-ops/head.js';
import { buildSummary } from '../summary/build.js';
import type { ResumeContextHolder, WorkflowContext } from '../types.js';
import {
  withPlannerCallPublishing,
  withReviewerCallPublishing,
  type PlannerCallPublisherContext,
} from './call-publishing.js';
import { initializeWorkflow } from './init/initialize.js';
import { runPlanningPhases } from './phases.js';
import { runTasksAndReview } from './task-execution.js';
import { recordFailure, trackedPhase } from './tracker.js';
import type { RunTracker, ScopedRun } from './types.js';

export async function runBody(run: ScopedRun, tracker: RunTracker): Promise<void> {
  try {
    await runPhases(run, tracker);
  } catch (err) {
    await killProcessScope(run.processScope);
    if (!run.opts.signal?.aborted || retentionError.isFailed(err)) {
      const bus = tracker.bus;
      const message = toErrorMessage(err);
      if (bus && tracker.state) {
        publishError({ bus, phase: tracker.state.phase, message });
      } else {
        // A failure raised before the run has a bus has no event to carry
        // it; without this the run returns an empty summary and says
        // nothing about why.
        warnError('Could not start the run', err, 'feedback');
      }
      if (tracker.state) tracker.state = recordFailure(run, tracker, tracker.state, message);
    }
    tracker.result = buildSummary({
      ...run.summaryBase,
      state: tracker.state ?? createInitialState(run.feature),
    });
  }
}

async function runPhases(run: ScopedRun, tracker: RunTracker): Promise<void> {
  const { opts, ref, feature, summaryBase } = run;
  const trackState = (state: WorkflowState): void => {
    tracker.state = state;
  };
  // Read progress after acquisition: the previous runner may have finished while orphan
  // cleanup was awaiting.
  const savedState =
    opts.prepared.purpose === 'new-workflow' ? undefined : readWorkflowStateHead(ref)?.state;
  if (opts.prepared.purpose !== 'new-workflow') reopenSessionRecord(ref);
  tracker.state = savedState ?? createInitialState(feature);
  const started = await initializeRun(run, tracker, savedState, trackState);
  if (started === undefined) return;
  const { wctx } = started;

  const planning = await runPlanningPhases({
    wctx,
    state: started.state,
    savedState,
    setTrackedState: trackState,
  });
  tracker.state = planning.state;

  switch (planning.disposition) {
    case 'terminal':
      if (planning.outcome === 'failed') {
        tracker.state = recordFailure(run, tracker, planning.state, 'Planning failed.');
      }
      tracker.result = buildSummary({ ...summaryBase, state: planning.state });
      return;
    case 'ready-for-tasks':
      break;
    default:
      return assertNever(planning);
  }

  if (opts.signal?.aborted) {
    tracker.result = buildSummary({ ...summaryBase, state: planning.state });
    return;
  }

  const taskRun = await runTasksAndReview({
    wctx,
    state: planning.state,
    planning,
    summaryBase,
    setTrackedState: trackState,
    setCurrentTask: (t) => {
      tracker.currentTask = t;
    },
  });
  tracker.result = taskRun.summary;
}

async function initializeRun(
  run: ScopedRun,
  tracker: RunTracker,
  savedState: WorkflowState | undefined,
  trackState: (state: WorkflowState) => void,
): Promise<{ wctx: WorkflowContext; state: WorkflowState } | undefined> {
  const { opts, ref, config, feature } = run;
  const resumeHolder: ResumeContextHolder = { messages: [] };
  const init = await initializeWorkflow({
    opts,
    config,
    sessionId: ref.sessionId,
    summaryBase: run.summaryBase,
    metadata: run.metadata,
    setTrackedState: trackState,
    getTrackedState: () => tracker.state,
    resumeHolder,
    isolation: run.isolation,
    savedState,
    newWorkflow: opts.prepared.purpose === 'new-workflow',
  });
  if (!init.ok) {
    tracker.bus = init.bus;
    tracker.result = init.summary;
    return undefined;
  }

  tracker.bus = init.wctx.bus;
  const callPublisher: PlannerCallPublisherContext = {
    bus: init.wctx.bus,
    getPhase: () => trackedPhase(tracker, feature),
  };
  const publishingPlanner = withPlannerCallPublishing(init.wctx.planner, callPublisher);
  const steering = createSteeringPort({
    onChange: (call) => {
      const seat = call === null ? null : seatForRunningCall(call);
      init.wctx.bus.publish({
        type: 'steerable_call',
        ts: Date.now(),
        phase: tracker.state?.phase ?? init.state.phase,
        ...(seat !== null && { seat }),
        ...(call !== null && call.taskId !== null && { taskId: call.taskId }),
      });
    },
  });
  const wctx: WorkflowContext = {
    ...init.wctx,
    steering,
    planner: publishingPlanner,
    reviewer:
      init.wctx.reviewer === init.wctx.planner
        ? publishingPlanner
        : withReviewerCallPublishing(init.wctx.reviewer, callPublisher),
  };
  tracker.state = init.state;

  installQueueHandler({
    processScope: run.processScope,
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    sinks: wctx.sinks,
    getTrackedState: () => tracker.state,
    setTrackedState: trackState,
    bus: wctx.bus,
    config,
    planner: wctx.planner,
    modelCache: wctx.modelCache,
    steering,
    ...(wctx.signal !== undefined && { signal: wctx.signal }),
  });
  return { wctx, state: init.state };
}
