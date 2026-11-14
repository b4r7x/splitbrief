import {
  followPendingReview,
  haltVerdictlessReview,
  followReviewAnswer,
  reviewPassed,
} from './review.js';
import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { reviewsAgain } from '../../../core/review/scope.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowContext } from '../types.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { runTaskLoop } from '../task/loop.js';
import { recordFinalReviewStatus, runFinalReviewPhase } from '../final-review.js';
import {
  type CheckRunResult,
  checkRegistry,
  planApprovesNpmScripts,
  runChecks,
} from '../validation/run-checks.js';
import { checkFailureText, newFailureKeys } from '../validation/failure-text.js';
import {
  classifyRequiredChecks,
  haltRequiredChecksUnrunnable,
  runPreReview,
} from './pre-review-checks.js';
import type { UnrunnableCheck } from '../recovery/builders/checks.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { captureReviewedCandidate } from '../apply/states.js';
import { bindApplyHandOffs } from '../apply/hand-off.js';
import { transitionAndSave } from '../state-ops.js';
import { parkAtBoundary, takeSeatChangeAtBoundary } from './boundary-park.js';
import { ensureRunBaselineSnapshot, recordRunSnapshotForRun } from './snapshots.js';
import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from '../isolation/acquisition.js';
import { runBaseOf } from '../isolation/base-tree.js';
import { error } from '../../../utils/error.js';
import { hasBaseline } from '../../snapshots/manifest.js';
import { runCodeDir } from '../kept-work.js';
import { type BaseSplit, splitCommandAtBase, startBaseGate } from '../base-gate.js';
import { planCheckRow, publishReviewCheck, unranCheckRow } from '../events.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
};

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
): Promise<{
  state: WorkflowState;
  failures: string[];
  notRun: string[];
  unrunnable: UnrunnableCheck[];
}> {
  let { state } = opts;
  const failures: string[] = [];
  const notRun: string[] = [];
  const unrunnable = new Map<string, UnrunnableCheck>();
  const applyReview = state.applyReview;
  if (applyReview === undefined) return { state, failures, notRun, unrunnable: [] };

  const { wctx, setTrackedState } = opts;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const base = runBaseOf(ref, state);
  if (state.phase === 'implementing') {
    state = transitionAndSave(ref, state, { type: 'ALL_DONE' });
    setTrackedState(state);
  }
  const checkOptions = {
    plan: state.plan,
    projectDir: wctx.workspaceDir,
    sessionId: wctx.sessionId,
    checkoutDir: wctx.projectDir,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    npmScriptsApproved: planApprovesNpmScripts({ config: wctx.config, state }),
    discoveredValidation: state.discoveredValidation,
    signal: wctx.signal,
    results: { ref, state, tree: 'workspace' as const },
  };
  const collectRuns = (
    owner: string,
    runs: readonly CheckRunResult[],
    settled: ReadonlySet<string>,
  ) => {
    const classified = classifyRequiredChecks(runs);
    for (const check of classified.unrunnable) {
      if (unrunnable.has(check.checkId) === false) unrunnable.set(check.checkId, check);
    }
    for (const run of runs) {
      if (settled.has(run.checkId)) continue;
      if (run.status === 'fail') {
        failures.push(`${owner} ${checkFailureText(run)}`);
      } else if (run.status !== 'pass') {
        const outcome = run.status === 'refused' ? 'refused' : 'not run';
        notRun.push(`${owner} check ${run.checkId} ${outcome}: ${run.output}`);
      }
    }
  };
  const splitRuns = async (runs: CheckRunResult[]) => {
    const settled = new Set<string>();
    const counts = new Map<string, BaseSplit['counts']>();
    for (const [index, run] of runs.entries()) {
      if (run.status !== 'fail' || run.command === undefined) continue;
      const split = await splitCommandAtBase({
        gate: wctx.baseGate,
        command: run.command,
        failure: run.failure,
        base,
      });
      if (split === undefined) continue;
      counts.set(run.checkId, split.counts);
      if (split.preExisting.length === 0) continue;
      const splitRun: CheckRunResult = { ...run, preExisting: split.preExisting };
      runs[index] = splitRun;
      if (newFailureKeys(splitRun).length === 0) settled.add(run.checkId);
    }
    return { settled, counts };
  };
  // With no review seat nobody reads the recheck's result, so each red shows on its own row.
  const noSeat = resolveReviewCadence(wctx.config) === 'none';
  const publishRechecked = (
    task: Task,
    runs: readonly CheckRunResult[],
    { settled, counts }: Awaited<ReturnType<typeof splitRuns>>,
  ) => {
    const registry = checkRegistry({ ...checkOptions, task });
    for (const run of runs) {
      if (run.status === 'pass' || settled.has(run.checkId)) continue;
      const row = {
        ...planCheckRow(run.checkId, run.command ?? '', registry.get(run.checkId)),
        taskId: task.id,
      };
      publishReviewCheck(
        { bus: wctx.bus, phase: checkOptions.phase },
        run.status === 'fail'
          ? {
              ...row,
              status: 'done',
              passed: false,
              ...(run.timedOut !== undefined && { timedOut: run.timedOut }),
              ...(run.reusedAt !== undefined && { reusedAt: run.reusedAt }),
              ...counts.get(run.checkId),
            }
          : { ...row, ...unranCheckRow(run) },
      );
    }
  };
  for (const task of state.tasks) {
    const checks = (task.checks ?? []).filter((check) => !noSeat || check.kind !== 'render');
    const runs = await runChecks(
      checks.map((check) => check.id),
      { ...checkOptions, task },
    );
    const split = await splitRuns(runs);
    const { settled } = split;
    if (noSeat) publishRechecked(task, runs, split);
    await recordCheckRuns({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      workspaceDir: wctx.workspaceDir,
      state,
      task,
      runs,
    });
    if (checks.length > 0) {
      state = transitionAndSave(ref, state, {
        type: 'RECORD_CHECK_RESULTS',
        taskId: task.id,
        results: runs.map((run) => ({
          id: run.checkId,
          status: settled.has(run.checkId) ? ('pass' as const) : run.status,
        })),
      });
      setTrackedState(state);
    }
    collectRuns(task.id, runs, settled);
  }
  const lastTask = state.tasks.at(-1);
  const plan = state.plan;
  if (!noSeat && lastTask !== undefined && plan !== undefined && plan.checks.length > 0) {
    const runs = await runChecks(
      plan.checks.map((check) => check.id),
      { ...checkOptions, task: lastTask },
    );
    const { settled } = await splitRuns(runs);
    await recordCheckRuns({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      workspaceDir: wctx.workspaceDir,
      state,
      task: lastTask,
      runs,
    });
    collectRuns('plan', runs, settled);
  }
  state = transitionAndSave(ref, state, { type: 'RECORD_APPLY_RECHECK', failures, notRun });
  setTrackedState(state);
  return { state, failures, notRun, unrunnable: [...unrunnable.values()] };
}

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; state: WorkflowState }> {
  const { setTrackedState, setCurrentTask } = opts;
  const initialWctx = opts.wctx;
  const { summaryBase } = opts;
  let { state } = opts;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state }),
    completed: false,
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
    // The checkout is its own base: there is no second tree to bring level with it.
    if (opened.kind !== 'checkout') {
      await reconcileWorkspaceToBase({
        ...ref,
        snapshotId: base.manifest.id,
        workspaceDir: opened.projectDir,
        keep: opened.keptFiles,
      });
    }
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
    const opened = await initialWctx.isolation.open({
      config: initialWctx.config,
      recorded: state.workspace.kind,
    });
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
  let phase = state.phase;
  const trackState = (next: WorkflowState) => {
    phase = next.phase;
    setTrackedState(next);
  };
  const baseGate = startBaseGate({
    ref,
    workspaceDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    state,
    phase: () => phase,
    signal: wctx.signal,
  });
  // The base run never outlives the run loop: it stops before the run's processes are killed, so a
  // killed base command is never stored as a red.
  try {
    return await buildAndReview({
      wctx: { ...wctx, baseGate },
      state,
      ref,
      summaryBase,
      setTrackedState: trackState,
      setCurrentTask,
    });
  } finally {
    await baseGate?.stop();
  }
}

/** The build and the review on the recorded run workspace, while the project gate runs at the run base. */
async function buildAndReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  ref: SessionRef;
  summaryBase: SummaryBase;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: RunTasksAndReviewOptions['setCurrentTask'];
}): Promise<{ summary: Summary; completed: boolean; state: WorkflowState }> {
  const { wctx, ref, summaryBase, setTrackedState, setCurrentTask } = args;
  const { callbacks } = wctx;
  let { state } = args;
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
    const parked = await parkAtBoundary({ wctx, state, park: taskResult.park, setTrackedState });
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

  if (wctx.signal?.aborted) {
    return {
      summary: buildSummary({ ...summaryBase, state }),
      completed: false,
      state,
    };
  }

  // runFinalReviewPhase dispatches ALL_DONE (legal only from 'implementing') on a fresh
  // run; a resumed 'final-review' state (a previously failed gate) re-enters review
  // directly to retry it to completion. Any other phase short-circuits to the summary.
  const canRunFinalReview = state.phase === 'implementing' || state.phase === 'final-review';
  if (taskResult.status !== 'complete' || !canRunFinalReview) {
    return {
      summary: buildSummary({ ...summaryBase, state }),
      completed: false,
      state,
    };
  }

  await recordRunSnapshotForRun({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  const summaryNow = () => buildSummary({ ...summaryBase, state });
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
    state,
  });

  // Runs the appended fix tasks. A boundary pause inside a fix cycle parks the run
  // exactly like the main loop: the park keeps the next brief or review step, and
  // continuing re-enters it. Returns the stop result when the loop did not complete.
  const runFixTasks = async () => {
    const boundary = await takeSeatChangeAtBoundary({ wctx, state, setTrackedState });
    state = boundary.state;
    if (boundary.stopped) return stopHere();
    let rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    while (rerun.status === 'paused') {
      const parked = await parkAtBoundary({ wctx, state, park: rerun.park, setTrackedState });
      state = parked.state;
      if (!parked.continued) break;
      rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
      state = rerun.state;
    }
    if (rerun.status === 'complete') return undefined;
    return {
      summary: summaryNow(),
      completed: false,
      state,
    };
  };

  const completeRun = () => {
    const summary = summaryNow();
    callbacks.onComplete(summary);
    return { summary, completed: true, state };
  };

  // REVIEW None ends here: the briefs ran their own checks and nothing else judges the result.
  if (resolveReviewCadence(wctx.config) === 'none') {
    if (wctx.signal?.aborted) return stopHere();
    const candidate = await captureCandidate();
    state = (await recheckMergedCandidate({ wctx, state, setTrackedState })).state;
    if (wctx.signal?.aborted) return stopHere();
    if (candidate !== undefined) {
      state = bindApplyHandOffs(ref, state, candidate);
      setTrackedState(state);
    }
    recordFinalReviewStatus(wctx, 'skipped');
    state = transitionAndSave(ref, state, {
      type: 'REVIEW_DONE',
      reviewStatus: 'none',
      ...(candidate !== undefined && { candidate }),
    });
    setTrackedState(state);
    wctx.bus.publish({
      type: 'workflow_complete',
      ts: Date.now(),
      phase: state.phase,
      review: 'none',
      completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
    });
    return completeRun();
  }

  // Each pass reviews the candidate and follows the answer. Fix tasks run before
  // the next gates; corrections and answers to that cycle's final review re-review
  // the same candidate.
  for (;;) {
    if (wctx.signal?.aborted) return stopHere();
    const boundary = await takeSeatChangeAtBoundary({ wctx, state, setTrackedState });
    state = boundary.state;
    if (boundary.stopped) return stopHere();
    const candidate = await captureCandidate();
    const answered = await followPendingReview({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
    });
    if (answered !== undefined) {
      state = answered.state;
      if (answered.next === 'stop') return stopHere();
      if (answered.next === 'accepted') return completeRun();
      if (answered.next === 'fix') {
        const stopped = await runFixTasks();
        if (stopped !== undefined) return stopped;
      }
      continue;
    }
    const reviewAgain = reviewsAgain(state, 'final');
    // A review that runs again on the same candidate reads the recheck the candidate already had.
    const recheck = reviewAgain
      ? {
          state,
          failures: state.applyReview?.failures ?? [],
          notRun: state.applyReview?.notRun ?? [],
          unrunnable: [],
        }
      : await recheckMergedCandidate({ wctx, state, setTrackedState });
    state = recheck.state;
    if (candidate !== undefined) {
      state = bindApplyHandOffs(ref, state, candidate);
      setTrackedState(state);
    }
    if (recheck.unrunnable.length > 0) {
      state = haltRequiredChecksUnrunnable({
        wctx,
        state,
        checks: recheck.unrunnable,
        setTrackedState,
      });
      return stopHere();
    }
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
      steering: wctx.steering,
      state,
      reviewer: wctx.reviewer,
      metadata: wctx.metadata,
      modelCache: wctx.modelCache,
      signal: wctx.signal,
      sinks: wctx.sinks,
      ...(wctx.continuation !== undefined && { continuation: wctx.continuation }),
      summaryBase,
      setTrackedState,
      ...(wctx.context.skillsContext !== undefined && {
        skillsContext: wctx.context.skillsContext,
      }),
      ...(integration !== undefined && { integration }),
      ...(!reviewAgain && {
        preReview: (s: WorkflowState) => runPreReview({ wctx, state: s, setTrackedState }),
      }),
      ...(!reviewAgain && { reviewChecks: { baseGate: wctx.baseGate } }),
    });
    state = review.state;
    setTrackedState(state);
    if (wctx.signal?.aborted) return stopHere();

    if (review.preReview === 'stopped') return stopHere();

    // A review that judged nothing is not a review that failed: it has no
    // blocker count to report, no brief to send back and no repair cycle to
    // spend. The run stays on this phase, halted on the review seat, until that
    // seat is answered — a fabricated `0 blocking findings` would close it.
    const halted = await haltVerdictlessReview({ wctx, state, setTrackedState, review });
    if (halted !== undefined) {
      state = halted;
      return stopHere();
    }

    if (reviewPassed(review.verdict?.outcome, review.fixWork, state.pendingTriage?.inputs ?? [])) {
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
      return completeRun();
    }
    const followed = await followReviewAnswer({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
      fixWork: review.fixWork,
    });
    state = followed.state;
    if (followed.next === 'stop') return stopHere();
    if (followed.next === 'accepted') return completeRun();
    if (followed.next === 'review') continue;

    const stopped = await runFixTasks();
    if (stopped !== undefined) return stopped;
  }
}
