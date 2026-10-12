import {
  answerPendingReviewQuestion,
  haltVerdictlessReview,
  followReviewAnswer,
  reviewPassed,
} from './review.js';
import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import { fixCyclesOf, type WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowContext } from '../types.js';
import { recordSteer } from '../continuation.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { runTaskLoop } from '../task/loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import {
  type CheckRunResult,
  checkRegistry,
  planApprovesNpmScripts,
  runChecks,
} from '../validation/run-checks.js';
import { checkFailureText, failureKeysForFile } from '../validation/failure-text.js';
import {
  classifyRequiredChecks,
  haltRequiredChecksUnrunnable,
  runPreReview,
} from './pre-review-checks.js';
import type { UnrunnableCheck } from '../recovery/builders/checks.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { captureReviewedCandidate } from '../apply/states.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { failingFilesFromKeys, lastTaskChangingFile } from '../task/file-owner.js';
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
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
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
  recordSteer({ ...ref, bus: wctx.bus }, state.phase, steer);
  state = rebaseOnPersistedWorkflowState(ref, state);
  setTrackedState(state);
  wctx.bus.publish({ type: 'workflow_resumed', ts: Date.now(), phase: state.phase });
  wctx.continuation?.hold(step, steer.text.trim() === '' ? undefined : steer);
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
): Promise<{
  state: WorkflowState;
  failures: string[];
  notRun: string[];
  inputs: TriageInput[];
  unrunnable: UnrunnableCheck[];
}> {
  let { state } = opts;
  const failures: string[] = [];
  const notRun: string[] = [];
  const inputs: TriageInput[] = [];
  const unrunnable = new Map<string, UnrunnableCheck>();
  const applyReview = state.applyReview;
  if (applyReview === undefined) return { state, failures, notRun, inputs, unrunnable: [] };

  const { wctx, setTrackedState } = opts;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
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
  };
  const ledger = readEvidenceLedger({ projectDir: wctx.projectDir, sessionId: wctx.sessionId });
  const registry = checkRegistry({ plan: state.plan, tasks: state.tasks });
  const pushFiles = (
    files: readonly (string | null)[],
    ownerLabel: string,
    run: CheckRunResult,
  ): void => {
    for (const file of files) {
      const owner = file === null ? undefined : lastTaskChangingFile(ledger, state.tasks, file);
      const failureKeys = failureKeysForFile({
        failure: run.status === 'fail' ? run.failure : null,
        file,
      });
      inputs.push({
        id: `A${inputs.length + 1}`,
        kind: 'defect',
        source: 'check',
        file,
        text: `${owner === undefined ? 'No task changed it.' : `Last changed by ${owner}.`}\n${ownerLabel} ${checkFailureText(run, { file })}`,
        checkIds: [run.checkId],
        ...(run.command !== undefined && { command: run.command }),
        output: run.output,
        ...(failureKeys.length > 0 && { failureKeys }),
        ...(run.status === 'fail' && { redKeys: run.failure.keys }),
      });
    }
  };
  const pushRun = (run: CheckRunResult, ownerLabel: string): void => {
    const check = registry.get(run.checkId);
    const named = failingFilesFromKeys(
      run.status === 'fail' ? run.failure.keys : [],
      wctx.workspaceDir,
    );
    const files =
      named.length > 0
        ? named
        : check?.kind === 'test'
          ? [normalizeProjectRelativePath(check.value)]
          : [null];
    pushFiles(files, ownerLabel, run);
  };
  const collectRuns = (owner: string, runs: readonly CheckRunResult[]) => {
    const required = classifyRequiredChecks(
      runs.filter((run) => registry.get(run.checkId)?.required === true),
    );
    for (const check of required.unrunnable) {
      if (unrunnable.has(check.checkId) === false) unrunnable.set(check.checkId, check);
    }
    for (const run of runs) {
      if (run.status === 'fail') {
        failures.push(`${owner} ${checkFailureText(run)}`);
        pushRun(run, owner);
      } else if (run.status !== 'pass') {
        const outcome = run.status === 'refused' ? 'refused' : 'not run';
        notRun.push(`${owner} check ${run.checkId} ${outcome}: ${run.output}`);
      }
    }
  };
  for (const task of state.tasks) {
    const runs = await runChecks(
      (task.checks ?? []).map((check) => check.id),
      { ...checkOptions, task },
    );
    await recordCheckRuns({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      workspaceDir: wctx.workspaceDir,
      state,
      task,
      runs,
    });
    if ((task.checks ?? []).length > 0) {
      state = transitionAndSave(ref, state, {
        type: 'RECORD_CHECK_RESULTS',
        taskId: task.id,
        results: runs.map((run) => ({ id: run.checkId, status: run.status })),
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
    await recordCheckRuns({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      workspaceDir: wctx.workspaceDir,
      state,
      task: lastTask,
      runs,
    });
    collectRuns('plan', runs);
  }
  state = transitionAndSave(ref, state, { type: 'RECORD_APPLY_RECHECK', failures });
  setTrackedState(state);
  return { state, failures, notRun, inputs, unrunnable: [...unrunnable.values()] };
}

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; state: WorkflowState }> {
  const { phaseTimings, setTrackedState, setCurrentTask } = opts;
  const initialWctx = opts.wctx;
  const { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = initialWctx;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state, phaseTimings }),
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
    state,
  });

  // Runs the appended fix tasks. A boundary pause inside a fix cycle parks the run
  // exactly like the main loop: the park keeps the next brief or review step, and
  // continuing re-enters it. Returns the stop result when the loop did not complete.
  const runFixTasks = async () => {
    let rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    taskBreakdowns = rerun.taskBreakdowns;
    while (rerun.status === 'paused') {
      const parked = await parkAtBoundary({ wctx, state, setTrackedState });
      state = parked.state;
      if (!parked.continued) break;
      rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
      state = rerun.state;
      taskBreakdowns = rerun.taskBreakdowns;
    }
    if (rerun.status === 'complete') return undefined;
    return {
      summary: summaryNow(),
      completed: false,
      state,
    };
  };

  // Each pass reviews the candidate and follows the answer. Fix tasks run before
  // the next gates; corrections and answers to that cycle's final review re-review
  // the same candidate.
  for (;;) {
    if (wctx.signal?.aborted) return stopHere();
    const candidate = await captureCandidate();
    const answered = await answerPendingReviewQuestion({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
    });
    if (answered !== undefined) {
      state = answered.state;
      if (answered.stopped) return stopHere();
    }
    const reviewAgain =
      state.pendingTriage !== undefined &&
      state.review !== undefined &&
      state.review.scope !== 'task' &&
      state.review.cycle === fixCyclesOf(state).used;
    const recheck = reviewAgain
      ? { state, failures: [], notRun: [], inputs: [], unrunnable: [] }
      : await recheckMergedCandidate({ wctx, state, setTrackedState });
    state = recheck.state;
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
      ...(!reviewAgain && {
        preReview: (s: WorkflowState) =>
          runPreReview({ wctx, state: s, setTrackedState, inputs: recheck.inputs }),
      }),
      reviewChecks: !reviewAgain,
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

    if (
      reviewPassed(
        review.verdict?.outcome,
        review.fixWork,
        state.pendingTriage?.inputs ?? [],
        recheck.failures,
      )
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
      return { summary, completed: true, state };
    }
    const followed = await followReviewAnswer({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
      recheckFailures: recheck.failures,
      fixWork: review.fixWork,
    });
    state = followed.state;
    if (followed.stopped) return stopHere();
    if (followed.reviewAgain) continue;

    const stopped = await runFixTasks();
    if (stopped !== undefined) return stopped;
  }
}
