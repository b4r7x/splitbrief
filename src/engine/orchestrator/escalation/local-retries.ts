import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishRetry } from '../events.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';
import { failedRetry, type EscalationContext, type RetryStepOutcome } from './types.js';
import { TIMEOUTS } from '../../../core/pipeline-spec/timeouts.js';
import type { RunnerFailureOutcomeState } from '../../runners/errors.js';
import { recoveryBuilderForRunnerOutcome } from '../recovery/builders/task.js';

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

export async function runLocalRetries(
  opts: Readonly<{
    ctx: EscalationContext;
    task: Task;
    state: WorkflowState;
    lastError: string;
  }>,
): Promise<RetryStepOutcome> {
  const { ctx } = opts;
  let state = opts.state;
  let task = opts.task;
  let lastError = opts.lastError;
  let attempts = 0;
  let consecutiveTimeouts = 0;
  const maxRetries = ctx.config.workflow.maxRetries;

  const textHandler = createBusTextHandler(
    { bus: ctx.bus, phase: state.phase },
    { role: 'implementer' },
  );

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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (ctx.signal?.aborted) break;
    attempts = attempt;
    const attemptBefore = state.attempt;
    if (state.phase === 'implementing') {
      state = persistTransition(state, { type: 'TASK_SENT' });
    }
    state = persistTransition(state, { type: 'VALIDATION_FAIL' }, { maxRetries });
    const retryRow = {
      bus: ctx.bus,
      phase: state.phase,
      taskId: task.id,
      attempt,
      maxRetries,
      error: lastError,
    };
    publishRetry(retryRow);
    if (state.phase === 'escalating') break;

    const outcome: RetryStepOutcome = await runRetryStep({
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
        languageContext: buildProjectLanguageContext(
          ctx.projectDir,
          state.discoveredValidation?.language,
        ),
        phase: state.phase,
        onOutput: textHandler,
      }),
    });

    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    if (outcome.result === undefined && isAbortedOutcome(lastError, ctx.signal)) {
      attempts = attempt - 1;
      const merged = rebaseOnPersistedWorkflowState(ctx, state);
      state = persistTransition(
        { ...merged, attempt: attemptBefore },
        {
          type: 'MARK_INJECTING_NATIVE',
          id: '__workflow_retry_abort__',
          attempt: attemptBefore,
        },
      );
      state = { ...state, attempt: attemptBefore };
      return { state, task, lastError, attempts, result: failedRetry(attempts) };
    }
    if (outcome.result) {
      return outcome;
    }
    const failure = outcome.lastFailure;
    if (failure !== undefined && haltsLocalRetries(failure.outcome)) {
      return outcome;
    }
    // An implementer that read the feedback and still wrote nothing will write
    // nothing again; the planner rung is the only thing left that can change it.
    if (failure?.outcome === 'no-staged-change') {
      return outcome;
    }
    if (failure?.outcome !== 'timeout') {
      consecutiveTimeouts = 0;
      continue;
    }
    consecutiveTimeouts += 1;
    if (consecutiveTimeouts >= TIMEOUTS.consecutiveTimeoutsHalt) {
      return {
        ...outcome,
        lastFailure: { ...failure, outcome: 'runner-timeout-repeated' },
      };
    }
  }

  return { state, task, lastError, attempts };
}
