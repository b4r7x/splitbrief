import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { planCheckRow, publishReviewCheck, unranCheckRow } from '../publish/review.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { runBaseOf } from '../isolation/run-base/tree.js';
import type { UnrunnableCheck } from '../recovery/builders/checks.js';
import { classifyRequiredChecks } from '../review/checks/required.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { type BaseSplit, splitCommandAtBase } from '../validation/base-gate.js';
import { planApprovesNpmScripts, checkRegistry, runChecks } from '../validation/checks/runner.js';
import type { CheckRunResult } from '../validation/checks/types.js';
import { checkFailureText, newFailureKeys } from '../validation/failure-text.js';
import type { RunTasksAndReviewOptions } from './types.js';

/**
 * The prompt section Apply's integration review reads: the checkout hunks the
 * merge folded in, then the checks that re-ran and what they found. It is a
 * section of its own so the review reads the merged result as one run diff.
 */
export function buildIntegrationSection(
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

export async function recheckMergedCandidate(
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
