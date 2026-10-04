import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowContext } from '../types.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { publishError } from '../events.js';
import { runTaskLoop } from '../task/loop.js';
import {
  REVIEW_UNAVAILABLE,
  runFinalReviewPhase,
  type FinalReviewFailure,
  type FinalReviewResult,
} from '../final-review.js';
import { decideReviewOutcome } from '../review-fix.js';
import { type CheckRunResult, runChecks } from '../validation/run-checks.js';
import { formatValidationError } from '../validation/format-error.js';
import { captureReviewedCandidate } from '../apply/states.js';
import { REVIEW_CYCLE_CAP } from '../../../core/pipeline-spec/review.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { reviewSeatDetails } from '../recovery/builders/details.js';
import { plannerCallHaltIssue } from '../recovery/planner-call-failure.js';
import { finalReviewFailedCause } from '../../../core/recovery/headline.js';
import { nowIso } from '../../../utils/format-time.js';
import { ensureRunBaselineSnapshot, recordRunSnapshotForRun } from './snapshots.js';
import { REVIEW_FILE, SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from '../isolation/acquisition.js';
import { error } from '../../../utils/error.js';
import { hasBaseline } from '../../snapshots/manifest.js';

export function runCodeDir(projectDir: string, workspace: WorkflowState['workspace']): string {
  return workspace?.path ?? projectDir;
}

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'files' | 'action'> | undefined) => void;
};

/**
 * Why this review reached no verdict, when it reached none. A result from before
 * the typed failure existed says only that nothing was written; that is a call
 * that did not land, carried under the one stable code rather than guessed at.
 */
function noVerdictFailure(review: FinalReviewResult): FinalReviewFailure | undefined {
  if (review.failure !== undefined) return review.failure;
  if (review.reviewStatus === 'written') return undefined;
  return {
    kind: 'call-failed',
    code: REVIEW_UNAVAILABLE,
    message: 'The final review reached no verdict, so nothing was judged.',
  };
}

/**
 * Pause after this brief, held in place. The state records the brief the run
 * will start next, so leaving the screen persists as a boundary park and the
 * run picks up there; `/resume` settles the promise and the loop carries on.
 */
async function parkAtBoundary(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; continued: boolean }> {
  const { wctx, setTrackedState } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const onContinuationNeeded = wctx.callbacks.onContinuationNeeded;
  const nextTask = args.state.tasks[args.state.currentTaskIndex];
  const step: StepRef =
    nextTask === undefined
      ? { kind: 'review', cycle: args.state.reviewFixes?.cycle ?? 0 }
      : { kind: 'brief', taskId: nextTask.id, attempt: 0 };

  let state = transitionAndSave(ref, args.state, {
    type: 'INTERRUPT_STEP',
    step,
    source: 'user',
    cut: 'boundary',
  });
  setTrackedState(state);
  wctx.bus.publish({
    type: 'turn_interrupted',
    ts: Date.now(),
    phase: state.phase,
    source: 'user',
    at: 'boundary',
    step,
  });

  // No prompt surface means nothing can continue this run in place; the park is
  // recorded and the run ends, resumable at the brief it stopped before.
  if (onContinuationNeeded === undefined) return { state, continued: false };

  const steer = await onContinuationNeeded('', 'boundary');
  if (wctx.signal?.aborted) return { state, continued: false };
  state = transitionAndSave(ref, state, { type: 'RESUME_STEP' });
  setTrackedState(state);
  wctx.continuation?.hold(step, steer.trim() === '' ? undefined : steer);
  return { state, continued: true };
}

/**
 * The prompt section Apply's integration review reads: the checkout hunks the
 * merge folded in, then the checks that re-ran and what they found. It is a
 * section of its own so the review reads the merged result as one run diff.
 */
function buildIntegrationSection(
  merged: readonly { path: string; checkoutHunks: string }[],
  failures: readonly string[],
  notRun: readonly string[],
): string {
  const lines = [
    '## Merged at Apply',
    'Your checkout changed files this run also changed. Apply merged them into the workspace; review the whole run diff, base to the merged result. The hunks below came from the checkout (base → checkout), file by file:',
  ];
  for (const entry of merged) {
    lines.push(`### ${entry.path}`, '```diff', entry.checkoutHunks, '```');
  }
  lines.push('## Checks re-run at Apply');
  if (failures.length === 0 && notRun.length === 0) lines.push('All re-run checks passed.');
  else for (const result of [...failures, ...notRun]) lines.push(`- ${result}`);
  return lines.join('\n');
}

async function recheckMergedCandidate(
  opts: Pick<RunTasksAndReviewOptions, 'wctx' | 'state' | 'setTrackedState'>,
): Promise<{ state: WorkflowState; failures: string[]; notRun: string[] }> {
  let { state } = opts;
  const failures: string[] = [];
  const notRun: string[] = [];
  const applyReview = state.applyReview;
  if (applyReview === undefined) return { state, failures, notRun };

  const { wctx, setTrackedState } = opts;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  if (state.phase === 'implementing') {
    state = transitionAndSave(ref, state, { type: 'ALL_DONE' });
    setTrackedState(state);
  }
  const mergedPaths = applyReview.merged.map((entry) => entry.path);
  const checkOptions = {
    plan: state.plan,
    projectDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    planApproved: true,
    discoveredValidation: state.discoveredValidation,
    signal: wctx.signal,
  };
  const collectRuns = (owner: string, runs: readonly CheckRunResult[]) => {
    for (const run of runs) {
      if (run.status === 'not-runnable') {
        notRun.push(`${owner} check ${run.checkId} not run: ${run.output}`);
      } else if (run.status !== 'pass') {
        failures.push(`${owner} check ${run.checkId} did not pass (${run.status}): ${run.output}`);
      }
    }
  };
  for (const task of state.tasks) {
    const results = await wctx.validator.runValidation({
      task,
      projectDir: wctx.workspaceDir,
      config: wctx.config,
      bus: wctx.bus,
      phase: state.phase,
      discoveredValidation: state.discoveredValidation,
      signal: wctx.signal,
      changedFiles: mergedPaths,
    });
    const acceptance = wctx.validator.decideAcceptance({ results, changedFiles: mergedPaths });
    if (!acceptance.accepted) {
      failures.push(`${task.id} validation: ${formatValidationError(results, acceptance)}`);
    }
    const runs = await runChecks(
      (task.checks ?? []).map((check) => check.id),
      { ...checkOptions, task },
    );
    if ((task.checks ?? []).length > 0) {
      state = transitionAndSave(ref, state, {
        type: 'RECORD_CHECK_RESULTS',
        taskId: task.id,
        results: runs.map((run) => ({ id: run.checkId, passed: run.status === 'pass' })),
      });
      setTrackedState(state);
    }
    collectRuns(task.id, runs);
  }
  const lastTask = state.tasks.at(-1);
  const plan = state.plan;
  if (lastTask !== undefined && plan !== undefined && plan.checks.length > 0) {
    const runs = await runChecks(
      plan.checks.map((check) => check.id),
      { ...checkOptions, task: lastTask },
    );
    collectRuns('plan', runs);
  }
  state = transitionAndSave(ref, state, { type: 'RECORD_APPLY_RECHECK', failures });
  setTrackedState(state);
  return { state, failures, notRun };
}

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; cancelled: boolean; state: WorkflowState }> {
  const { phaseTimings, setTrackedState, setCurrentTask } = opts;
  const initialWctx = opts.wctx;
  const { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = initialWctx;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state, phaseTimings }),
    completed: false,
    cancelled: false,
    state,
  });

  if (opts.planning.disposition !== 'ready-for-tasks') {
    return bail();
  }

  await ensureRunBaselineSnapshot({
    projectDir: initialWctx.projectDir,
    sessionId: initialWctx.sessionId,
    bus: initialWctx.bus,
    phase: state.phase,
  });

  const ref = { projectDir: initialWctx.projectDir, sessionId: initialWctx.sessionId };
  if (!(await hasBaseline(ref.projectDir, ref.sessionId))) {
    throw error(
      'run-baseline-snapshot-missing',
      'The run baseline snapshot could not be initialized; workspace acquisition stopped.',
    );
  }
  if (state.workspace === undefined) {
    const base = await createSnapshot({
      ...ref,
      phase: 'manual',
      name: 'workspace-base',
      bus: initialWctx.bus,
      eventPhase: state.phase,
    });
    if (base.manifest.id === SNAPSHOT_BASELINE_ID) {
      throw error(
        'run-workspace-base-is-baseline',
        'Workspace acquisition requires a snapshot distinct from the session baseline.',
      );
    }
    const opened = await initialWctx.isolation.open({ config: initialWctx.config });
    await reconcileWorkspaceToBase({
      ...ref,
      snapshotId: base.manifest.id,
      workspaceDir: opened.projectDir,
      keep: opened.keptFiles,
    });
    state = transitionAndSave(ref, state, {
      type: 'RECORD_WORKSPACE',
      workspace: {
        kind: opened.kind,
        path: opened.projectDir,
        base: { snapshotId: base.manifest.id, head: opened.head },
      },
    });
    setTrackedState(state);
  } else {
    const opened = await initialWctx.isolation.open({ config: initialWctx.config });
    if (opened.projectDir !== state.workspace.path) {
      throw error(
        'run-workspace-moved',
        `The recorded run workspace at ${state.workspace.path} is gone or replaced; opening ${opened.projectDir} would create a second workspace.`,
      );
    }
  }
  const wctx = {
    ...initialWctx,
    workspaceDir: runCodeDir(initialWctx.projectDir, state.workspace),
  };

  const phaseStart = Date.now();
  let taskResult = await runTaskLoop({
    wctx,
    initialState: state,
    setTrackedState,
    setCurrentTask,
  });
  state = taskResult.state;

  // Pause after this brief holds the run in place rather than ending it: the
  // operator continues into the next brief, or leaves and resumes later.
  while (taskResult.status === 'paused') {
    const parked = await parkAtBoundary({ wctx, state, setTrackedState });
    state = parked.state;
    if (!parked.continued) break;
    taskResult = await runTaskLoop({
      wctx,
      initialState: state,
      setTrackedState,
      setCurrentTask,
    });
    state = taskResult.state;
  }

  phaseTimings.implementing = Date.now() - phaseStart;

  if (wctx.signal?.aborted) {
    return {
      summary: buildSummary({
        ...summaryBase,
        state,
        taskBreakdowns: taskResult.taskBreakdowns,
        phaseTimings,
      }),
      completed: false,
      cancelled: false,
      state,
    };
  }

  // runFinalReviewPhase dispatches ALL_DONE (legal only from 'implementing') on a fresh
  // run; a resumed 'final-review' state (a previously failed gate) re-enters review
  // directly to retry it to completion. Any other phase short-circuits to the summary.
  const canRunFinalReview = state.phase === 'implementing' || state.phase === 'final-review';
  if (taskResult.status !== 'complete' || !canRunFinalReview) {
    return {
      summary: buildSummary({
        ...summaryBase,
        state,
        taskBreakdowns: taskResult.taskBreakdowns,
        phaseTimings,
      }),
      completed: false,
      cancelled: taskResult.status === 'cancelled',
      state,
    };
  }

  await recordRunSnapshotForRun({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  let taskBreakdowns = taskResult.taskBreakdowns;
  const summaryNow = () => buildSummary({ ...summaryBase, state, taskBreakdowns, phaseTimings });
  const captureCandidate = async (): Promise<Record<string, string> | undefined> => {
    const workspace = state.workspace;
    return workspace !== undefined &&
      (workspace.kind === 'worktree' || workspace.kind === 'staged-copy')
      ? captureReviewedCandidate({
          projectDir: wctx.projectDir,
          sessionId: wctx.sessionId,
          workspace,
        })
      : undefined;
  };

  // The review owns the run's exit: a `fail` it can attribute to briefs sends
  // those briefs back through implementation and asks again, up to the cap.
  // The budget is durable: a resumed final review restarts from the cycles its
  // earlier invocations already spent, so continuing never mints new ones.
  for (let cycle = state.reviewFixes?.cycle ?? 0; ; cycle++) {
    const candidate = await captureCandidate();
    const recheck = await recheckMergedCandidate({ wctx, state, setTrackedState });
    state = recheck.state;
    const integration =
      state.applyReview === undefined
        ? undefined
        : buildIntegrationSection(state.applyReview.merged, recheck.failures, recheck.notRun);
    const review = await runFinalReviewPhase({
      projectDir: wctx.projectDir,
      workspaceDir: wctx.workspaceDir,
      sessionId: wctx.sessionId,
      config: wctx.config,
      callbacks,
      bus: wctx.bus,
      state,
      reviewer: wctx.reviewer,
      metadata: wctx.metadata,
      signal: wctx.signal,
      sinks: wctx.sinks,
      ...(wctx.continuation !== undefined && { continuation: wctx.continuation }),
      summaryBase,
      taskBreakdowns,
      phaseTimings,
      setTrackedState,
      ...(wctx.context.skillsContext !== undefined && {
        skillsContext: wctx.context.skillsContext,
      }),
      ...(integration !== undefined && { integration }),
    });
    state = review.state;
    setTrackedState(state);
    if (wctx.signal?.aborted) {
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    // A review that judged nothing is not a review that failed: it has no
    // blocker count to report, no brief to send back and no repair cycle to
    // spend. The run stays on this phase, halted on the review seat, until that
    // seat is answered — a fabricated `0 blocking findings` would close it.
    const failure = noVerdictFailure(review);
    // A seat out of quota or signed out halts the way a planner call does; the
    // review already published the tool's own words, so no second error row. A
    // review that follows the planner runs on the plan seat's tool, so its swap
    // moves the plan seat and the review keeps following it.
    if (failure?.kind === 'seat-blocked') {
      const reviewer = resolveReviewerRunner(wctx.config);
      const followsPlan = reviewer.source === 'planner';
      const issue = await plannerCallHaltIssue({
        projectDir: wctx.projectDir,
        diagnosis: failure.diagnosis,
        phase: state.phase,
        seat: 'review',
        swap: { seat: followsPlan ? 'plan' : 'review', runner: reviewer.runner },
        details: reviewSeatDetails(followsPlan),
      });
      state = raisePendingRecovery({ ...ref, bus: wctx.bus }, state, issue, setTrackedState);
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }
    if (failure !== undefined) {
      const issue = buildReviewFailedRecoveryIssue({
        phase: state.phase,
        failure,
        createdAt: nowIso(),
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: issue.message,
        safety: { category: 'recovery', code: 'review_failed' },
      });
      state = raisePendingRecovery({ ...ref, bus: wctx.bus }, state, issue, setTrackedState);
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    const decision = decideReviewOutcome(
      review,
      state.tasks,
      REVIEW_CYCLE_CAP,
      cycle,
      recheck.failures,
    );
    const completedTasks = state.tasks.filter((task) => isTaskCompleted(task.status)).length;
    if (decision.kind === 'pass') {
      state = transitionAndSave(ref, state, {
        type: 'REVIEW_DONE',
        reviewStatus: 'passed',
        ...(candidate !== undefined && { candidate }),
      });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'passed',
        completedTasks,
      });
      const summary = summaryNow();
      callbacks.onComplete(summary);
      return { summary, completed: true, cancelled: false, state };
    }

    if (decision.kind === 'fail') {
      state = transitionAndSave(ref, state, {
        type: 'REVIEW_DONE',
        reviewStatus: 'failed',
        ...(candidate !== undefined && { candidate }),
      });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'failed',
        blocking: decision.blocking,
        completedTasks,
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: `${finalReviewFailedCause(decision.blocking)}; see ${REVIEW_FILE}`,
        safety: { category: 'recovery', code: 'review_failed' },
      });
      state = raisePendingRecovery(
        { ...ref, bus: wctx.bus },
        state,
        buildReviewFailedRecoveryIssue({
          blocking: decision.blocking,
          phase: state.phase,
          createdAt: nowIso(),
          acceptAsIs:
            state.workspace?.kind === 'worktree' || state.workspace?.kind === 'staged-copy',
        }),
        setTrackedState,
      );
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    const nextCycle = cycle + 1;
    state = transitionAndSave(ref, state, {
      type: 'REVIEW_FIX_START',
      fixes: decision.fixes,
      cycle: nextCycle,
    });
    setTrackedState(state);
    wctx.bus.publish({
      type: 'review_fix_started',
      ts: Date.now(),
      phase: state.phase,
      cycle: nextCycle,
      taskIds: state.tasks.filter((t) => decision.fixes[t.id] !== undefined).map((t) => t.id),
    });

    let rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    taskBreakdowns = rerun.taskBreakdowns;
    // A boundary pause inside a repair parks the run exactly like the main
    // loop: the park keeps the next brief or review step and the cycles
    // already spent, and continuing re-enters this same repair.
    while (rerun.status === 'paused') {
      const parked = await parkAtBoundary({ wctx, state, setTrackedState });
      state = parked.state;
      if (!parked.continued) break;
      rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
      state = rerun.state;
      taskBreakdowns = rerun.taskBreakdowns;
    }
    if (rerun.status !== 'complete') {
      return {
        summary: summaryNow(),
        completed: false,
        cancelled: rerun.status === 'cancelled',
        state,
      };
    }
  }
}
