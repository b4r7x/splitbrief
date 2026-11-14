import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { publishNoProgressCut } from '../publish/task.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep, type RetryStepResult } from './step.js';
import { failedRetry, type EscalationContext, type RetryAttemptFailure } from './types.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { recoveryBuilderForRunnerOutcome } from '../recovery/builders/runner-outcome.js';

/**
 * Outcomes every further attempt reproduces: a signed-out or quota-exhausted
 * runner, plus every runner defect the recovery builders already recognise. The
 * attempt is not counted, so the caller halts the ladder instead of escalating
 * to the planner over a defect no attempt can fix.
 */
function haltsLadder(outcome: RunnerFailureOutcomeState): boolean {
  return (
    outcome === 'unauthenticated' ||
    outcome === 'usage-limit' ||
    outcome === 'tool-use-limit' ||
    recoveryBuilderForRunnerOutcome(outcome) !== undefined
  );
}

export function isAbortedOutcome(lastError: string, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return lastError === ABORTED_OUTCOME_TEXT;
}

/**
 * The session log's record of a cut. A cut is an ordinary failed attempt on the
 * lineage — the consult that follows is already the ladder's own mechanics — so
 * nothing else changes here. Only a set `idleKillMs` cuts a call, so the record
 * quotes it; a runner without one has no silence limit to quote, and the log
 * records no cut for it.
 */
export function recordNoProgressCut(
  ctx: EscalationContext,
  task: Task,
  state: WorkflowState,
  failure: RetryAttemptFailure | undefined,
): void {
  if (failure?.outcome !== 'no-progress-cut') return;
  const runner = failure.runner;
  if (!('idleKillMs' in runner) || runner.idleKillMs === undefined) return;
  publishNoProgressCut(
    { bus: ctx.bus, phase: state.phase },
    { taskId: task.id, seat: 'build', silentMs: runner.idleKillMs },
  );
}

/**
 * Delivers the correction the user sent while the checks ran. The attempt is not
 * a consult: it carries the user's words, and a correction sent during its own
 * checks is delivered by one more attempt. The caller consults on any red that
 * remains.
 */
export async function runHeldCorrection(
  opts: Readonly<{
    ctx: EscalationContext;
    task: Task;
    state: WorkflowState;
    answer: string;
  }>,
): Promise<RetryStepResult> {
  const { ctx } = opts;
  let state = opts.state;
  let task = opts.task;
  let lastError = opts.answer;
  let lastFailure: RetryAttemptFailure | undefined;
  let attemptSnapshot: ChangedFilesSnapshot | undefined;
  let answer: string | undefined = opts.answer;

  while (answer !== undefined && !ctx.signal?.aborted) {
    const outcome: RetryStepResult = await runRetryStep({
      ctx,
      task,
      state,
      lastError: answer,
      attempts: 0,
      deliversAnswer: true,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'Retry failed to produce valid code',
      invokeRetry: makeImplementerRetryInvoker({
        context: ctx.context,
        steering: ctx.steering,
        kind: 'correction',
        sessionId: ctx.sessionId,
        languageContext: buildProjectLanguageContext(
          ctx.projectDir,
          state.discoveredValidation?.language,
        ),
        phase: state.phase,
      }),
    });

    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    lastFailure = outcome.lastFailure;
    answer = outcome.answer;
    attemptSnapshot = outcome.attemptSnapshot ?? attemptSnapshot;
    // An attempt whose failure halts the ladder is not a used attempt.
    if (lastFailure !== undefined && haltsLadder(lastFailure.outcome)) {
      return { ...outcome, state };
    }
    state = transitionAndSave(
      ctx,
      state,
      {
        type: 'COUNT_ATTEMPT',
        taskId: task.id,
        ...(outcome.result === undefined && { failure: lastError }),
      },
      { expectedRevision: state.stateRevision },
    );
    recordNoProgressCut(ctx, task, state, lastFailure);
    if (outcome.result === undefined && isAbortedOutcome(lastError, ctx.signal)) {
      return {
        state,
        task,
        lastError,
        attempts: 0,
        result: failedRetry(0),
        ...(attemptSnapshot !== undefined && { attemptSnapshot }),
      };
    }
    if (outcome.result) return { ...outcome, state };
    if (outcome.blocked !== undefined) {
      return { ...outcome, state, ...(attemptSnapshot !== undefined && { attemptSnapshot }) };
    }
  }

  return {
    state,
    task,
    lastError,
    attempts: 0,
    ...(lastFailure !== undefined && { lastFailure }),
    ...(attemptSnapshot !== undefined && { attemptSnapshot }),
  };
}
