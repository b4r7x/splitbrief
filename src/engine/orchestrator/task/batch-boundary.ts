import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { TriageInput } from '../../../core/schemas/review.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import { transitionAndSave } from '../state-ops.js';
import { haltUnansweredTriage, runTriage } from '../triage.js';
import type { FullSuiteFailureKeys } from '../validation/types.js';
import type { ValidationResult } from '../validation/result.js';
import type { WorkflowContext } from '../types.js';
import { buildFullSuiteInputs } from './file-owner.js';

export type BatchBoundaryResult = Readonly<{
  state: WorkflowState;
  status: 'continue' | 'stopped';
}>;

export function isBatchBoundary(tasks: readonly Task[], completedIndex: number): boolean {
  const completed = tasks[completedIndex];
  if (completed === undefined || !isTaskCompleted(completed.status)) return false;
  const batch = completed.batch ?? 1;
  for (let i = completedIndex + 1; i < tasks.length; i++) {
    const candidate = tasks[i];
    if (candidate === undefined || isTaskCompleted(candidate.status)) continue;
    if ((candidate.batch ?? 1) === batch) return false;
  }
  return true;
}

function hasNewFailures(newFailures: FullSuiteFailureKeys): boolean {
  return Object.values(newFailures).some((keys) => (keys?.length ?? 0) > 0);
}

export function buildBoundaryInputs(
  newFailures: FullSuiteFailureKeys,
  tasks: readonly Task[],
  ledger: EvidenceLedger | null,
): TriageInput[] {
  return buildFullSuiteInputs({
    newFailures,
    tasks,
    ledger,
    idPrefix: 'B',
    place: 'at a batch boundary',
  });
}

async function recordBoundarySuite(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  results: readonly ValidationResult[];
}): Promise<void> {
  const { wctx, state, task, results } = args;
  await recordCheckRuns({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    workspaceDir: wctx.workspaceDir,
    state,
    task,
    validation: results,
  });
}

export async function runBatchBoundary(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  completedTask: Task;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<BatchBoundaryResult> {
  const { wctx, setTrackedState } = args;
  let state = args.state;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const batch = args.completedTask.batch ?? 1;
  const afterTaskId = args.completedTask.id;
  state = transitionAndSave(ref, state, { type: 'SET_PENDING_BOUNDARY', batch, afterTaskId });
  setTrackedState(state);
  const suite = await wctx.validator.runFullSuite({
    projectDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    phase: state.phase,
    discoveredValidation: state.discoveredValidation,
    signal: wctx.signal,
    baseline: state.fullSuiteBaseline,
  });
  await recordBoundarySuite({ wctx, state, task: args.completedTask, results: suite.results });
  if (!hasNewFailures(suite.newFailures)) {
    state = transitionAndSave(ref, state, { type: 'CLEAR_PENDING_BOUNDARY' });
    setTrackedState(state);
    return { state, status: 'continue' };
  }

  const inputs = buildBoundaryInputs(
    suite.newFailures,
    state.tasks,
    readEvidenceLedger({ projectDir: wctx.projectDir, sessionId: wctx.sessionId }),
  );
  if (inputs.length === 0) {
    state = transitionAndSave(ref, state, { type: 'CLEAR_PENDING_BOUNDARY' });
    setTrackedState(state);
    return { state, status: 'continue' };
  }

  const triaged = await runTriage(
    {
      projectDir: wctx.projectDir,
      workspaceDir: wctx.workspaceDir,
      sessionId: wctx.sessionId,
      bus: wctx.bus,
      config: wctx.config,
      planner: wctx.planner,
      callbacks: wctx.callbacks,
      sinks: wctx.sinks,
      state,
      ...(wctx.signal !== undefined && { signal: wctx.signal }),
      onStateChange: (next) => {
        state = next;
        setTrackedState(next);
      },
    },
    { inputs, batch, afterTaskId },
  );
  if (triaged.kind === 'triaged') {
    state = transitionAndSave(ref, state, { type: 'CLEAR_PENDING_BOUNDARY' });
    setTrackedState(state);
    return { state, status: 'continue' };
  }
  const halted = haltUnansweredTriage({
    wctx,
    state,
    outcome: triaged,
    setTrackedState,
    diagnosis: 'The batch-boundary suite found new failures.',
    source: 'batch-boundary',
  });
  return { state: halted, status: 'stopped' };
}
