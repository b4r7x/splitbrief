import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishChecksRun } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import {
  planApprovesNpmScripts,
  runChecks,
  type CheckRunResult,
} from '../validation/run-checks.js';
import { recordCheckRuns } from '../evidence/record-checks.js';

export type TaskChecksResult = Readonly<{
  state: WorkflowState;
  runs: CheckRunResult[];
}>;

type TaskChecksContext = Pick<
  WorkflowContext,
  'projectDir' | 'workspaceDir' | 'sessionId' | 'config' | 'bus' | 'signal'
>;

export async function runTaskChecksAfterAcceptance(opts: {
  wctx: TaskChecksContext;
  state: WorkflowState;
  task: Task;
  alreadyRun?: readonly CheckRunResult[] | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
}): Promise<TaskChecksResult> {
  const { wctx, task } = opts;
  let state = opts.state;
  const alreadyRun = opts.alreadyRun ?? [];
  const done = new Set(alreadyRun.map((run) => run.checkId));
  const pending = (task.checks ?? []).filter((check) => !done.has(check.id));
  const newRuns: CheckRunResult[] =
    pending.length === 0
      ? []
      : await runChecks(
          pending.map((check) => check.id),
          {
            task,
            plan: state.plan,
            projectDir: wctx.workspaceDir,
            sessionId: wctx.sessionId,
            checkoutDir: wctx.projectDir,
            config: wctx.config,
            bus: wctx.bus,
            phase: state.phase,
            npmScriptsApproved: planApprovesNpmScripts({ config: wctx.config, state }),
            ...(state.discoveredValidation !== undefined && {
              discoveredValidation: state.discoveredValidation,
            }),
            ...(wctx.signal !== undefined && { signal: wctx.signal }),
          },
        );
  const runs = [...alreadyRun, ...newRuns];
  if (runs.length === 0) return { state, runs };
  const checkResults = runs.map((run) => ({ id: run.checkId, passed: run.status === 'pass' }));
  state = transitionAndSave({ projectDir: wctx.projectDir, sessionId: wctx.sessionId }, state, {
    type: 'RECORD_CHECK_RESULTS',
    taskId: task.id,
    results: checkResults,
  });
  opts.setTrackedState?.(state);
  publishChecksRun({ bus: wctx.bus, phase: state.phase }, task.id, checkResults);
  await recordCheckRuns({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspaceDir: wctx.workspaceDir,
    state,
    task,
    runs,
  });
  return { state, runs };
}
