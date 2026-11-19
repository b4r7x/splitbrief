import type { Task } from '../../../core/schemas/task.js';
import { TIMEOUTS } from '../../../core/pipeline-spec/timeouts.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { buildSeatHalt, raiseSeatHalt } from './halts.js';
import { recordNoProgressCut } from './held-correction.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';
import type {
  EscalationContext,
  LadderEnd,
  LadderState,
  RetryAttemptFailure,
  RetryStepOutcome,
  RetryStepResult,
} from './types.js';
import { failedRetry } from './types.js';

/** A timeout and a no-progress cut both end a call that did not finish. */
export function isUnfinishedCall(failure: RetryAttemptFailure | undefined): boolean {
  return failure?.outcome === 'timeout' || failure?.outcome === 'no-progress-cut';
}

/**
 * A seat that cannot work and a runner defect halt the ladder at once: the same failure comes
 * back on every further attempt, and the next rung would spend a consult on a brief no retry can
 * land.
 */
async function runnerHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): Promise<LadderEnd | null> {
  const failure = stepOutcome.lastFailure;
  if (failure === undefined) return null;
  const halt = await buildSeatHalt(ctx, stepOutcome.state, task, {
    outcome: failure.outcome,
    runner: failure.runner,
    toolMessage: stepOutcome.lastError,
    transportError: failure.transportError,
    // The ladder books a timeout before it names the second one in a row a defect.
    booked: failure.outcome === 'runner-timeout-repeated',
  });
  if (halt === undefined) return null;
  return {
    state: raiseSeatHalt(ctx, stepOutcome.state, task, halt),
    result: failedRetry(stepOutcome.attempts),
  };
}

/**
 * Timeouts and no-progress cuts share one count: two unfinished calls in a row halt as
 * `runner-timeout-repeated`; any other outcome resets it. The call is booked by then, so the halt
 * reads the ladder's state.
 */
async function countUnfinishedCall(
  ctx: EscalationContext,
  ladder: LadderState,
  outcome: RetryStepOutcome,
): Promise<LadderEnd | null> {
  const failure = outcome.lastFailure;
  ladder.unfinishedCalls = isUnfinishedCall(failure) ? ladder.unfinishedCalls + 1 : 0;
  if (failure === undefined || ladder.unfinishedCalls < TIMEOUTS.consecutiveTimeoutsHalt) {
    return null;
  }
  return runnerHalt(ctx, ladder.task, {
    ...outcome,
    state: ladder.state,
    lastFailure: { ...failure, outcome: 'runner-timeout-repeated' },
  });
}

/** The ladder takes what an attempt left: its state, brief, error, hand-back, snapshot and report. */
export function absorbOutcome(ladder: LadderState, outcome: RetryStepResult): void {
  ladder.state = outcome.state;
  ladder.task = outcome.task;
  ladder.lastError = outcome.lastError;
  ladder.handBack = outcome.lastFailure?.handBack ?? ladder.handBack;
  ladder.attemptSnapshot = outcome.attemptSnapshot ?? ladder.attemptSnapshot;
  ladder.blocked = outcome.blocked;
}

/**
 * The halt a failed attempt earns: a seat or runner halt on the state the attempt returned, else
 * the halt of a second unfinished call in a row.
 */
export async function attemptHalt(
  ctx: EscalationContext,
  ladder: LadderState,
  outcome: RetryStepOutcome,
): Promise<LadderEnd | null> {
  return (
    (await runnerHalt(ctx, outcome.task, outcome)) ??
    (await countUnfinishedCall(ctx, ladder, outcome))
  );
}

/**
 * One attempt after a consult, or the attempt that delivers the user's answer. The lineage books
 * it; a result, a stop or a halt ends the ladder, and `null` goes back to the consult.
 */
export async function runConsultAttempt(
  ctx: EscalationContext,
  ladder: LadderState,
  attemptError: string,
  deliversAnswer: boolean,
): Promise<LadderEnd | null> {
  if (ctx.signal?.aborted) return { state: ladder.state, result: failedRetry(ladder.attempts) };
  const outcome = await runRetryStep({
    ctx,
    task: ladder.task,
    state: ladder.state,
    lastError: attemptError,
    attempts: ladder.attempts + 1,
    deliversAnswer,
    method: 'consulted',
    transitionType: 'VALIDATION_PASS',
    commitSuffix: 'after consult',
    usageCategory: 'implementer',
    retryFailureFallback: 'Consult-guided retry failed to produce valid code',
    invokeRetry: makeImplementerRetryInvoker({
      context: ctx.context,
      steering: ctx.steering,
      kind: 'consult',
      sessionId: ctx.sessionId,
      languageContext: buildProjectLanguageContext(
        ctx.projectDir,
        ladder.state.discoveredValidation?.language,
      ),
      phase: ladder.state.phase,
    }),
  });
  absorbOutcome(ladder, outcome);
  ladder.attempts = outcome.attempts;
  ladder.answer = outcome.answer;
  ladder.state = transitionAndSave(ctx, ladder.state, {
    type: 'COUNT_ATTEMPT',
    taskId: ladder.task.id,
    ...(outcome.result === undefined && { failure: ladder.lastError }),
  });
  recordNoProgressCut(ctx, ladder.task, ladder.state, outcome.lastFailure);
  if (outcome.result) return { state: ladder.state, result: outcome.result };
  if (ctx.signal?.aborted) return { state: ladder.state, result: failedRetry(ladder.attempts) };
  return attemptHalt(ctx, ladder, outcome);
}
