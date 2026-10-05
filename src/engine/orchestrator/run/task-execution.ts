import { haltVerdictlessReview, triageFailedReview } from './review.js';
import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import { fixCyclesOf, type WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowContext } from '../types.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { type CheckRunResult, runChecks } from '../validation/run-checks.js';
import { formatValidationError } from '../validation/format-error.js';
import { captureReviewedCandidate } from '../apply/states.js';
import { transitionAndSave } from '../state-ops.js';
import { ensureRunBaselineSnapshot, recordRunSnapshotForRun } from './snapshots.js';
import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
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
      ? { kind: 'review', cycle: fixCyclesOf(args.state).used }
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

  const stopHere = () => ({
    summary: summaryNow(),
    completed: false,
    cancelled: false,
    state,
  });

  // The review owns the run's exit. A failing review goes to one planner triage call: its
  // fix tasks are appended, one fix cycle is spent and the task loop runs them, then the
  // review asks again. At the cap, or with nothing for a triage to answer, the run halts.
  for (;;) {
    if (wctx.signal?.aborted) return stopHere();
    let candidate: Record<string, string> | undefined;
    let recheckFailures: readonly string[] = [];

    if (state.pendingTriage === undefined || state.review === undefined) {
      candidate = await captureCandidate();
      const recheck = await recheckMergedCandidate({ wctx, state, setTrackedState });
      state = recheck.state;
      recheckFailures = recheck.failures;
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
      if (wctx.signal?.aborted) return stopHere();

      // A review that judged nothing is not a review that failed: it has no
      // blocker count to report, no brief to send back and no repair cycle to
      // spend. The run stays on this phase, halted on the review seat, until that
      // seat is answered — a fabricated `0 blocking findings` would close it.
      const halted = await haltVerdictlessReview({ wctx, state, setTrackedState, review });
      if (halted !== undefined) {
        state = halted;
        return stopHere();
      }

      const outcome = review.verdict?.outcome;
      // A candidate whose fresh Apply re-checks failed is never passed: the review
      // word cannot overrule the checks run against the merged workspace.
      if (
        outcome !== undefined &&
        outcome.kind !== 'fail' &&
        recheck.failures.length === 0 &&
        state.pendingTriage === undefined
      ) {
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
          completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
        });
        const summary = summaryNow();
        callbacks.onComplete(summary);
        return { summary, completed: true, cancelled: false, state };
      }
    }

    // A judged failure: the review this pass ran, or the saved one an operator correction
    // queued. Its blocking findings and the pending inputs are the triage's inputs.
    const triaged = await triageFailedReview({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
      recheckFailures,
    });
    state = triaged.state;
    if (triaged.stopped) return stopHere();

    let rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    taskBreakdowns = rerun.taskBreakdowns;
    // A boundary pause inside a fix cycle parks the run exactly like the main loop:
    // the park keeps the next brief or review step, and continuing re-enters it.
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
