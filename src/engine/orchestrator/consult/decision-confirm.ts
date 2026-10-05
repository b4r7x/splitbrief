import type { ImplementerReport } from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import {
  decisionConfirmsOf,
  type ChangedFilesSnapshot,
  type WorkflowState,
} from '../../../core/schemas/workflow.js';
import { decisionLedgerText } from '../../../core/state/machine.js';
import { consultAttemptError, guidanceInstructions } from '../escalation/consult-guidance.js';
import { publishWarning } from '../events.js';
import type { WorkflowContext } from '../types.js';
import { applyConsultAnswer } from './apply.js';
import { requestConsult } from './request.js';

type DecisionConfirmOutcome =
  | { kind: 'validate'; state: WorkflowState }
  | { kind: 'retry'; state: WorkflowState; error: string };

/** Confirms an attempt's new decisions before validation, or carries the user's answer into a retry. */
export async function confirmAttemptDecisions(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  report: Extract<ImplementerReport, { status: 'done' }> | undefined;
  snapshot: ChangedFilesSnapshot;
  changedFiles: readonly string[];
  onStateChange?: ((state: WorkflowState) => void) | undefined;
}): Promise<DecisionConfirmOutcome> {
  const { wctx, task, report } = opts;
  let state = opts.state;
  if (report === undefined) return { kind: 'validate', state };
  const decisions = report.decisions.filter(
    (decision) =>
      !state.plan?.decisions.some(
        (entry) => entry.taskId === task.id && entry.text === decisionLedgerText(decision),
      ),
  );
  if (decisions.length === 0) return { kind: 'validate', state };

  const warn = (reason: string): void =>
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `${task.id}'s reported decisions were not confirmed or added to the ledger: ${reason}`,
    });
  const counter = decisionConfirmsOf(state);
  if (counter.used >= counter.allowance) {
    warn("the run's decision-confirm allowance is spent");
    return { kind: 'validate', state };
  }
  const onStateChange = (next: WorkflowState): void => {
    state = next;
    opts.onStateChange?.(next);
  };
  const outcome = await requestConsult(
    { ...wctx, state, onStateChange },
    {
      task,
      reason: 'deviation',
      failingOutput: '',
      report: { ...report, decisions },
      snapshot: opts.snapshot,
      changedFiles: opts.changedFiles,
    },
  );
  if ('error' in outcome) {
    warn(outcome.error.message);
    return { kind: 'validate', state };
  }
  const applied = await applyConsultAnswer(
    { ...wctx, state, changedFiles: opts.changedFiles, onStateChange },
    task,
    outcome.answer,
    opts.snapshot,
  );
  if (applied.action === 'guidance') {
    return {
      kind: 'retry',
      state,
      error: consultAttemptError(
        'The planner asked the user about the decisions this attempt reported.',
        guidanceInstructions(applied.instructions, applied.context),
      ),
    };
  }
  if (applied.action === 'failed') return { kind: 'retry', state, error: applied.reason };
  return { kind: 'validate', state };
}
