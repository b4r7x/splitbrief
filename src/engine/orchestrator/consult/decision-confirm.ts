import type { ImplementerReport } from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { decisionLedgerText } from '../../../core/state/machine.js';
import { consultAttemptError, guidanceInstructions } from '../escalation/consult-guidance.js';
import { publishWarning } from '../events.js';
import type { WorkflowContext } from '../types.js';
import { applyConsultAnswer } from './apply.js';
import { consultSeat, requestConsult } from './request.js';

type DecisionConfirmOutcome =
  | { kind: 'validate'; state: WorkflowState }
  | { kind: 'retry'; state: WorkflowState; error: string }
  | { kind: 'answer'; state: WorkflowState; answer: string };

/**
 * Confirms an attempt's new decisions before validation. A question the planner asks goes to
 * the user, and the planner is asked once more with the answer in the brief's operator
 * instructions: a confirm sends the kept work to validation with no new build call, and
 * guidance returns the change for the next attempt to deliver. When that second call fails or its
 * question stays unanswered, the next attempt delivers the first answer. A first question left
 * unanswered returns a failure to retry.
 */
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
  const seat = consultSeat(task, 'deviation');
  const onStateChange = (next: WorkflowState): void => {
    state = next;
    opts.onStateChange?.(next);
  };
  // The user's answer to the first question, which the next attempt delivers when the planner
  // cannot be asked again.
  let delivery: string | undefined;
  for (;;) {
    const answered = delivery !== undefined;
    const outcome = await requestConsult(
      { ...wctx, state, onStateChange },
      {
        task,
        reason: 'deviation',
        failingOutput: '',
        report: { ...report, decisions },
        snapshot: opts.snapshot,
        changedFiles: opts.changedFiles,
        answered,
      },
    );
    if ('error' in outcome) {
      warn(outcome.error.message);
      return delivery === undefined
        ? { kind: 'validate', state }
        : { kind: 'answer', state, answer: delivery };
    }
    const applied = await applyConsultAnswer(
      {
        ...wctx,
        state,
        seat,
        changedFiles: opts.changedFiles,
        onStateChange,
      },
      task,
      outcome.answer,
      opts.snapshot,
    );
    if (applied.action === 'correction') return { kind: 'answer', state, answer: applied.answer };
    if (applied.action === 'failed') {
      return delivery === undefined
        ? { kind: 'retry', state, error: applied.reason }
        : { kind: 'answer', state, answer: delivery };
    }
    if (applied.action !== 'guidance') return { kind: 'validate', state };
    const asked = outcome.answer.answer.action === 'ask-user';
    const answer = consultAttemptError({
      lastError: asked
        ? 'The planner asked the user about the decisions this attempt reported.'
        : 'The planner asked for a change to the decisions this attempt reported.',
      instructions: guidanceInstructions(applied.instructions, applied.context),
      seat,
    });
    if (asked && !answered) {
      delivery = answer;
      continue;
    }
    return { kind: 'answer', state, answer };
  }
}
