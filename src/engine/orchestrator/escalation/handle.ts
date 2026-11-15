import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { ConsultQuestion } from '../../../core/schemas/consult.js';
import type { WorkflowContext } from '../types.js';
import { isAbortedOutcome, recordNoProgressCut, runHeldCorrection } from './held-correction.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { preEscalationHalt } from './pre-hook.js';
import { absorbOutcome, attemptHalt, isUnfinishedCall } from './attempt.js';
import { runLadder } from './ladder.js';
import type {
  BlockedReport,
  EscalationContext,
  LadderEnd,
  LadderState,
  RetryAttemptFailure,
} from './types.js';
import { failedRetry } from './types.js';

type HandleRetryOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  currentState: WorkflowState;
  taskStartSnapshot: ChangedFilesSnapshot;
  dependsOnFiles: string[];
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
  /** The first attempt's blocked report, when it stopped asking for a decision. */
  initialBlocked?: BlockedReport | undefined;
  /** The user's answer to a change of what the first attempt reported. */
  initialAnswer?: string | undefined;
  /** The unfinished calls in a row before a consult that runs again, which its halt kept. */
  unfinishedCalls?: number | undefined;
  /** Receives the question of each consult before it is asked, for a halt on that consult. */
  onConsult: (question: ConsultQuestion) => void;
};

/**
 * The ladder: every red goes to the consult seat with the exact errors. A
 * guidance or ask-user answer spends one more implementer attempt with the
 * consult seat's instructions in its error block; a rewrite or a split replaces
 * the brief and hands back to the task loop; verify completes in place. A
 * correction the user sent while the checks ran is delivered by the next
 * attempt, before any consult. No count stops the loop: each
 * failed attempt goes back to the consult seat, whose prompt shows its earlier
 * answers and the failures that followed them. A question of the seat that
 * nobody answers halts the brief for the operator.
 */
export async function handleRetryAndEscalation(opts: HandleRetryOptions): Promise<LadderEnd> {
  const { wctx, taskStartSnapshot } = opts;
  const ctx: EscalationContext = {
    ...wctx,
    taskStartSnapshot,
    dependsOnFiles: opts.dependsOnFiles,
  };
  const ladder: LadderState = {
    state: opts.currentState,
    task: opts.task,
    lastError: opts.initialError,
    attempts: 0,
    handBack: undefined,
    blocked: opts.initialBlocked,
    attemptSnapshot: taskStartSnapshot,
    answer: undefined,
    unfinishedCalls: opts.unfinishedCalls ?? (isUnfinishedCall(opts.initialFailure) ? 1 : 0),
  };

  if (isAbortedOutcome(ladder.lastError, ctx.signal)) {
    return { state: ladder.state, result: failedRetry(ladder.attempts) };
  }
  // The first attempt can be the one the watchdog cut; record it before the consult it earns.
  recordNoProgressCut(ctx, ladder.task, ladder.state, opts.initialFailure);

  if (ladder.blocked === undefined && opts.initialAnswer !== undefined) {
    const held = await runHeldCorrection({
      ctx,
      task: ladder.task,
      state: ladder.state,
      answer: opts.initialAnswer,
    });
    absorbOutcome(ladder, held);
    if (held.result) return { state: ladder.state, result: held.result };
    if (ctx.signal?.aborted) return { state: ladder.state, result: failedRetry(ladder.attempts) };
    const heldHalt = await attemptHalt(ctx, ladder, held);
    if (heldHalt) return heldHalt;
  }

  // Every red goes to the consult seat: the brief is escalating from here.
  if (ladder.state.phase === 'implementing') {
    ladder.state = transitionAndSave(ctx, ladder.state, { type: 'TASK_SENT' });
  }
  ladder.state = transitionAndSave(ctx, ladder.state, { type: 'VALIDATION_FAIL' });

  const hookHalt = await preEscalationHalt(ctx, ladder.state, ladder.task, ladder.lastError);
  if (hookHalt !== undefined) return { state: hookHalt, result: failedRetry(ladder.attempts) };

  // Every answer from here is the consult seat's or the operator's.
  wctx.bus.publish({
    type: 'task_escalating',
    ts: Date.now(),
    phase: ladder.state.phase,
    taskId: ladder.task.id,
  });

  return runLadder(ctx, ladder, opts.onConsult);
}
