import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import {
  createBusTextHandler,
  publishConsultBoundSpent,
  publishError,
  publishNoProgressCut,
  publishRetry,
} from '../events.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import {
  attemptBoundSpent,
  buildConsultBoundRecoveryIssue,
  type ConsultBoundSpent,
} from '../recovery/builders/consult.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep, type RetryStepResult } from './step.js';
import { failedRetry, type EscalationContext, type RetryAttemptFailure } from './types.js';
import { RUNNER_IDLE_KILL_MS } from '../../../core/schemas/runner-fields.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import { TIMEOUTS } from '../../../core/pipeline-spec/timeouts.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { recoveryBuilderForRunnerOutcome } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';

/**
 * Outcomes every further local attempt reproduces: a signed-out or
 * quota-exhausted runner, plus every runner defect the recovery builders
 * already recognise. The retries stop so the caller halts the ladder instead of
 * escalating to the planner over a defect no retry can fix.
 */
function haltsLocalRetries(outcome: RunnerFailureOutcomeState): boolean {
  return (
    outcome === 'unauthenticated' ||
    outcome === 'usage-limit' ||
    recoveryBuilderForRunnerOutcome(outcome) !== undefined
  );
}

function isAbortedOutcome(lastError: string, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return lastError === ABORTED_OUTCOME_TEXT;
}

/**
 * The session log's record of a cut. A cut is an ordinary failed attempt on the
 * lineage — the retry and the consult that follow are already the ladder's own
 * mechanics — so nothing else changes here.
 */
export function recordNoProgressCut(
  ctx: EscalationContext,
  task: Task,
  state: WorkflowState,
  failure: RetryAttemptFailure | undefined,
): void {
  if (failure?.outcome !== 'no-progress-cut') return;
  const runner = failure.runner;
  const silentMs =
    'idleKillMs' in runner && runner.idleKillMs !== undefined
      ? runner.idleKillMs
      : RUNNER_IDLE_KILL_MS;
  publishNoProgressCut(
    { bus: ctx.bus, phase: state.phase },
    { taskId: task.id, seat: 'build', silentMs },
  );
}

/** The ladder cannot ask the planner again; the operator decides the grant. */
function raiseConsultBound(
  ctx: EscalationContext,
  state: WorkflowState,
  task: Task,
  lastDiagnosis: string,
  attempts: number,
  spent: ConsultBoundSpent,
): RetryStepResult {
  const issue = buildConsultBoundRecoveryIssue({
    reason: spent.reason,
    phase: state.phase,
    task,
    lastDiagnosis,
    consults: spent.consults,
    consultAllowance: spent.consultAllowance,
    attempts: spent.attempts,
    attemptAllowance: spent.attemptAllowance,
    plannerCalls: spent.plannerCalls,
    plannerCallAllowance: spent.plannerCallAllowance,
    createdAt: nowIso(),
  });
  publishConsultBoundSpent({ bus: ctx.bus, phase: state.phase });
  publishError({
    bus: ctx.bus,
    phase: state.phase,
    message: issue.message,
    safety: {
      category: 'recovery',
      code: spent.reason === 'planner-calls-spent' ? 'planner_calls_spent' : 'consult_bound_spent',
    },
  });
  return {
    state: raisePendingRecovery(ctx, state, issue),
    task,
    lastError: lastDiagnosis,
    attempts,
    result: failedRetry(attempts),
  };
}

export async function runLocalRetries(
  opts: Readonly<{
    ctx: EscalationContext;
    task: Task;
    state: WorkflowState;
    lastError: string;
    initialFailure?: RetryAttemptFailure | undefined;
  }>,
): Promise<RetryStepResult> {
  const { ctx } = opts;
  let state = opts.state;
  let task = opts.task;
  let lastError = opts.lastError;
  let attempts = 0;
  let consecutiveTimeouts = opts.initialFailure?.outcome === 'timeout' ? 1 : 0;
  let lastFailure: RetryAttemptFailure | undefined;
  let attemptSnapshot: ChangedFilesSnapshot | undefined;
  const maxRetries = DEFAULT_LOCAL_RETRIES;

  const persistTransition = (
    current: WorkflowState,
    action: Parameters<typeof transitionAndSave>[2],
    extra: Parameters<typeof transitionAndSave>[3] = undefined,
  ): WorkflowState =>
    transitionAndSave(ctx, current, action, {
      expectedRevision: current.stateRevision,
      ...extra,
    });

  if (isAbortedOutcome(lastError, ctx.signal)) {
    return { state, task, lastError, attempts, result: failedRetry(attempts) };
  }

  // The first attempt can be the one the watchdog cut; record it before the
  // retry it earns.
  recordNoProgressCut(ctx, task, state, opts.initialFailure);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (ctx.signal?.aborted) break;
    const spent = attemptBoundSpent(state, task);
    if (spent !== undefined) {
      return raiseConsultBound(ctx, state, task, lastError, attempts, spent);
    }
    if (state.phase === 'implementing') {
      state = persistTransition(state, { type: 'TASK_SENT' });
    }
    state = persistTransition(state, { type: 'VALIDATION_FAIL' });
    attempts = state.attempt;
    const retryRow = {
      bus: ctx.bus,
      phase: state.phase,
      taskId: task.id,
      attempt: state.attempt,
      maxRetries,
      error: lastError,
    };
    publishRetry(retryRow);
    if (state.phase === 'escalating') break;

    const outcome: RetryStepResult = await runRetryStep({
      ctx,
      task,
      state,
      lastError,
      attempts,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'Retry failed to produce valid code',
      profileOverride: ctx.retryProfileOverride,
      invokeRetry: makeImplementerRetryInvoker({
        context: ctx.context,
        kind: 'local',
        sessionId: ctx.sessionId,
        languageContext: buildProjectLanguageContext(
          ctx.projectDir,
          state.discoveredValidation?.language,
        ),
        phase: state.phase,
        onOutput: createBusTextHandler(
          { bus: ctx.bus, phase: state.phase },
          { role: 'implementer' },
        ),
      }),
    });

    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    lastFailure = outcome.lastFailure;
    attemptSnapshot = outcome.attemptSnapshot ?? attemptSnapshot;
    state = persistTransition(state, { type: 'COUNT_ATTEMPT', taskId: task.id });
    recordNoProgressCut(ctx, task, state, lastFailure);
    if (outcome.result === undefined && isAbortedOutcome(lastError, ctx.signal)) {
      return {
        state,
        task,
        lastError,
        attempts,
        result: failedRetry(attempts),
        ...(attemptSnapshot !== undefined && { attemptSnapshot }),
      };
    }
    if (outcome.result) {
      return { ...outcome, state };
    }
    // An implementer that stopped to ask for a decision is answered by the
    // planner, not by another attempt with the same brief.
    if (outcome.blocked !== undefined) {
      return {
        ...outcome,
        state,
        task,
        lastError,
        attempts,
        ...(attemptSnapshot !== undefined && { attemptSnapshot }),
      };
    }
    const failure = outcome.lastFailure;
    if (failure !== undefined && haltsLocalRetries(failure.outcome)) {
      return { ...outcome, state };
    }
    // An implementer that read the feedback and still wrote nothing will write
    // nothing again; the planner is the only thing left that can change it.
    if (failure?.outcome === 'no-staged-change') {
      return { ...outcome, state };
    }
    if (failure?.outcome !== 'timeout') {
      consecutiveTimeouts = 0;
      continue;
    }
    consecutiveTimeouts += 1;
    if (consecutiveTimeouts >= TIMEOUTS.consecutiveTimeoutsHalt) {
      return {
        ...outcome,
        state,
        lastFailure: { ...failure, outcome: 'runner-timeout-repeated' },
      };
    }
  }

  return {
    state,
    task,
    lastError,
    attempts,
    ...(lastFailure !== undefined && { lastFailure }),
    ...(attemptSnapshot !== undefined && { attemptSnapshot }),
  };
}
