import type { Task } from '../../../core/schemas/task.js';
import type {
  ChangedFilesSnapshot,
  FailureMark,
  WorkflowState,
} from '../../../core/schemas/workflow.js';
import { failureMark, judgeProgress, type ProgressStop } from '../../../core/state/progress.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import type { ConsultReason } from '../../../core/schemas/consult.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { recordNoProgressCut, runLocalRetries } from './local-retries.js';
import { runRetryStep, type BlockedReport } from './step.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { consultSeat, requestConsult } from '../consult/request.js';
import { applyConsultAnswer } from '../consult/apply.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { revertedDir } from '../../../core/paths.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { buildNoProgressRecoveryIssue } from '../recovery/builders/consult.js';
import { haltAttempts } from '../recovery/builders/details.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildSeatDownIssue,
  recoveryBuilderForRunnerOutcome,
  runnerDefectRow,
  runnerHaltRow,
} from '../recovery/builders/task.js';
import { classifySeatFailure, type SeatFailureClassification } from '../../runners/seat-failure.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { nowIso } from '../../../utils/format-time.js';
import { consultAttemptError, guidanceInstructions } from './consult-guidance.js';
import type {
  EscalationContext,
  RetryAttemptFailure,
  RetryResult,
  RetryStepOutcome,
} from './types.js';
import { failedRetry } from './types.js';

type HandleRetryOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  currentState: WorkflowState;
  taskStartSnapshot?: ChangedFilesSnapshot;
  dependsOnFiles?: string[];
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
  /** The checks that failed the first attempt. */
  initialChecks?: FailureMark | undefined;
  /** The first attempt's blocked report, when it stopped asking for a decision. */
  initialBlocked?: BlockedReport | undefined;
  /** The user's answer to a change of what the first attempt reported. */
  initialAnswer?: string | undefined;
};

function handBackOf(outcome: RetryStepOutcome): string | undefined {
  return outcome.lastFailure?.handBack;
}

/**
 * A seat that cannot work halts the ladder at once: a signed-out or
 * quota-exhausted runner reproduces the same failure on every further attempt,
 * and the next rung would spend a consult on a brief no retry can land.
 * The one seat-down halt is raised on the attempt that failed — no retry, no
 * consult — and carries the fallback the seat can move to automatically.
 */
async function seatDownHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): Promise<{ state: WorkflowState; result: RetryResult } | null> {
  const failure = stepOutcome.lastFailure;
  if (failure?.outcome !== 'unauthenticated' && failure?.outcome !== 'usage-limit') return null;
  const seatSwap = await loadSeatSwapContext({
    projectDir: ctx.projectDir,
    modelCache: ctx.modelCache,
    seat: 'build',
    runner: failure.runner,
    config: ctx.config,
    implementerProfile: ctx.implementerProfile,
  });
  const classification: SeatFailureClassification =
    failure.outcome === 'unauthenticated'
      ? { class: 'account', cause: 'auth' }
      : classifySeatFailure({
          message: stepOutcome.lastError,
          outcome: 'usage-limit',
          source: 'result-error',
        });
  const issue = buildSeatDownIssue({
    task,
    phase: stepOutcome.state.phase,
    seat: 'build',
    runner: failure.runner,
    classification,
    words: stepOutcome.lastError,
    ...haltAttempts(stepOutcome.state, task, { booked: false }),
    ...(ctx.implementerProfile !== undefined && {
      selectedImplementerProfile: ctx.implementerProfile,
    }),
    ...(seatSwap !== undefined && { seatSwap }),
    seatSwitches: stepOutcome.state.seatSwitches,
    createdAt: nowIso(),
  });
  publishError({
    bus: ctx.bus,
    phase: stepOutcome.state.phase,
    message: runnerHaltRow(
      issue,
      getRunnerCatalogDisplayName(failure.runner),
      stepOutcome.lastError,
    ),
    ...(issue.resetAt !== undefined && { resetAt: issue.resetAt }),
  });
  // A seat that is down cuts the brief it was running: the park names the step
  // and keeps its workspace, so the switch resolves onto the same attempt.
  const parked = transitionAndSave(ctx, stepOutcome.state, {
    type: 'INTERRUPT_STEP',
    step: { kind: 'brief', taskId: task.id, attempt: stepOutcome.state.attempt },
    source: 'seat',
    cut: 'mid-step',
  });
  return {
    state: raisePendingRecovery(ctx, parked, issue),
    result: failedRetry(stepOutcome.attempts),
  };
}

/**
 * An outcome the recovery builders recognise as a runner defect halts the
 * ladder for the same reason the seat-down halt does — the next rung would
 * pay a consult to hint around the same defect.
 */
async function runnerDefectHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): Promise<{ state: WorkflowState; result: RetryResult } | null> {
  const failure = stepOutcome.lastFailure;
  if (failure === undefined) return null;
  const build = recoveryBuilderForRunnerOutcome(failure.outcome);
  if (build === undefined) return null;
  const seatSwap = await loadSeatSwapContext({
    projectDir: ctx.projectDir,
    modelCache: ctx.modelCache,
    seat: 'build',
    runner: failure.runner,
    config: ctx.config,
    implementerProfile: ctx.implementerProfile,
    refusal: stepOutcome.lastError,
  });
  const issue = build({
    task,
    phase: stepOutcome.state.phase,
    runner: failure.runner,
    toolMessage: stepOutcome.lastError,
    // The local ladder books a timeout before it names the second one in a row a defect.
    ...haltAttempts(stepOutcome.state, task, {
      booked: failure.outcome === 'runner-timeout-repeated',
    }),
    ...(ctx.implementerProfile !== undefined && {
      selectedImplementerProfile: ctx.implementerProfile,
    }),
    ...(seatSwap !== undefined && { seatSwap }),
    seatSwitches: stepOutcome.state.seatSwitches,
    ...(stepOutcome.state.workspace?.kind === 'checkout' && {
      inPlace: { revertedDir: revertedDir(ctx) },
    }),
    createdAt: nowIso(),
  });
  publishError({
    bus: ctx.bus,
    phase: stepOutcome.state.phase,
    message: runnerDefectRow(
      issue,
      getRunnerCatalogDisplayName(failure.runner),
      stepOutcome.lastError,
    ),
  });
  return {
    state: raisePendingRecovery(ctx, stepOutcome.state, issue),
    result: failedRetry(stepOutcome.attempts),
  };
}

async function runnerHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): Promise<{ state: WorkflowState; result: RetryResult } | null> {
  const seatDown = await seatDownHalt(ctx, task, stepOutcome);
  if (seatDown) return seatDown;
  return runnerDefectHalt(ctx, task, stepOutcome);
}

/** The files this attempt changed since its snapshot; a diff the consult cannot render is empty. */
async function attemptChangedFiles(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  try {
    return await getChangedFilesSinceSnapshot(projectDir, snapshot);
  } catch {
    return [];
  }
}

type NoProgress = Readonly<{
  task: Task;
  stop: ProgressStop;
  failure: FailureMark;
  answers: number;
  lastError: string;
  attempts: number;
  handBack: string | undefined;
}>;

/** The planner's answers did not move the failure, or the lineage used all its answers; the operator decides. */
function noProgressHalt(
  ctx: EscalationContext,
  state: WorkflowState,
  halt: NoProgress,
): { state: WorkflowState; result: RetryResult } {
  const { task } = halt;
  const lastConsult = state.lineages?.[lineageIdOf(task)]?.consultRecords.at(-1);
  const issue = buildNoProgressRecoveryIssue({
    phase: state.phase,
    task,
    stop: halt.stop,
    failure: halt.failure,
    answers: halt.answers,
    lastDiagnosis: lastConsult?.diagnosis ?? halt.lastError,
    failingOutput: halt.lastError,
    ...haltAttempts(state, task, { booked: true }),
    createdAt: nowIso(),
  });
  publishError({
    bus: ctx.bus,
    phase: state.phase,
    message: issue.message,
    safety: { category: 'recovery', code: 'no_progress' },
  });
  return {
    state: raisePendingRecovery(ctx, state, issue),
    result: failedRetry(halt.attempts, {
      lastError: halt.lastError,
      ...(halt.handBack !== undefined && { handBack: halt.handBack }),
    }),
  };
}

/**
 * The ladder: one local rung with the exact errors, then the consult loop. A
 * guidance or ask-user answer spends one more implementer attempt with the
 * consult seat's instructions in its error block; a rewrite or a split replaces
 * the brief and hands back to the task loop; verify completes in place. A
 * correction the user sent while the checks ran is delivered by the next
 * attempt, with no retry rung and no consult. Before each consult the failure is
 * judged against the one the last answer saw: two answers in a row that did not
 * move it, or too many answers on the lineage, halt for the operator with the
 * failure and the last diagnosis.
 */
export async function handleRetryAndEscalation(
  opts: HandleRetryOptions,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const { wctx, initialError, currentState } = opts;
  let taskStartSnapshot = opts.taskStartSnapshot;
  if (!taskStartSnapshot) {
    try {
      taskStartSnapshot = await captureWorkspaceSnapshot(wctx.workspaceDir, wctx);
    } catch (err) {
      publishWarningFromError(
        { bus: wctx.bus, phase: currentState.phase },
        'retry approval snapshot failed',
        err,
      );
      return { state: currentState, result: failedRetry(0) };
    }
  }
  const ctx: EscalationContext = {
    ...wctx,
    taskStartSnapshot,
    dependsOnFiles: opts.dependsOnFiles ?? [],
  };

  let task = opts.task;
  let state = currentState;
  let lastError = initialError;
  let attempts = 0;
  let handBack: string | undefined;
  let blocked: BlockedReport | undefined = opts.initialBlocked;
  let attemptSnapshot: ChangedFilesSnapshot = taskStartSnapshot;
  let checks = opts.initialChecks;
  let callOutcome = opts.initialFailure?.outcome;
  let answer: string | undefined;

  if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };

  // An implementation that stopped to ask for a decision is not retried with
  // the same brief: the consult seat answers the question.
  if (blocked === undefined) {
    const retries = await runLocalRetries({
      ctx,
      task,
      state,
      lastError,
      checks,
      ...(opts.initialFailure !== undefined && { initialFailure: opts.initialFailure }),
      ...(opts.initialAnswer !== undefined && { answer: opts.initialAnswer }),
    });
    state = retries.state;
    task = retries.task;
    lastError = retries.lastError;
    checks = retries.checks;
    callOutcome = retries.lastFailure?.outcome;
    attempts = retries.attempts;
    handBack = handBackOf(retries) ?? handBack;
    attemptSnapshot = retries.attemptSnapshot ?? attemptSnapshot;
    blocked = retries.blocked;
    if (retries.result) return { state, result: retries.result };
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };
    const retriesHalt = await runnerHalt(ctx, retries.task, retries);
    if (retriesHalt) return retriesHalt;
  }

  if (ctx.config.hooks) {
    const preEscalationPayload: EngineEvent = {
      type: 'task_escalating',
      ts: Date.now(),
      phase: state.phase,
      taskId: task.id,
    };
    const pre = await runPreHooks(ctx.config.hooks, 'pre_escalation', preEscalationPayload, {
      projectDir: ctx.projectDir,
      workspaceDir: ctx.workspaceDir,
      sessionId: ctx.sessionId,
    });
    if (!pre.allow) {
      const reason = pre.reason ?? 'hook denied';
      publishWarning({
        bus: ctx.bus,
        phase: state.phase,
        message: `pre_escalation blocked: ${reason}`,
      });
      const issue = buildRetryExhaustedRecoveryIssue({
        task,
        phase: state.phase,
        escalationBlockedBy: reason,
        validationSummary: lastError,
        ...haltAttempts(state, task, { booked: true }),
        allowRetryOverride: true,
        ...(ctx.implementerProfile !== undefined && {
          selectedImplementerProfile: ctx.implementerProfile,
        }),
        createdAt: nowIso(),
      });
      const nextState = raisePendingRecovery(ctx, state, issue);
      return { state: nextState, result: failedRetry(attempts) };
    }
  }

  // The local rung is over: the brief is escalating, and every answer from here
  // is the consult seat's or the operator's.
  wctx.bus.publish({
    type: 'task_escalating',
    ts: Date.now(),
    phase: state.phase,
    taskId: task.id,
  });

  const attempt = async (
    attemptError: string,
    deliversAnswer: boolean,
  ): Promise<{ state: WorkflowState; result: RetryResult } | null> => {
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };
    const nextAttempts = attempts + 1;
    const outcome = await runRetryStep({
      ctx,
      task,
      state,
      lastError: attemptError,
      attempts: nextAttempts,
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
          state.discoveredValidation?.language,
        ),
        phase: state.phase,
      }),
    });
    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    attempts = outcome.attempts;
    handBack = handBackOf(outcome) ?? handBack;
    attemptSnapshot = outcome.attemptSnapshot ?? attemptSnapshot;
    blocked = outcome.blocked;
    answer = outcome.answer;
    checks = outcome.checks;
    callOutcome = outcome.lastFailure?.outcome;
    state = transitionAndSave(ctx, state, {
      type: 'COUNT_ATTEMPT',
      taskId: task.id,
      ...(outcome.result === undefined && { failure: lastError }),
    });
    recordNoProgressCut(ctx, task, state, outcome.lastFailure);
    if (outcome.result) return { state, result: outcome.result };
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };
    return runnerHalt(ctx, outcome.task, outcome);
  };

  for (;;) {
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };

    // The user's answer is not a consult: the next attempt delivers it.
    if (answer !== undefined) {
      const halted = await attempt(answer, true);
      if (halted) return halted;
      continue;
    }

    const progress = state.lineages?.[lineageIdOf(task)]?.progress;
    const failure = failureMark({
      ...(checks !== undefined && { checks }),
      ...(callOutcome !== undefined && { callOutcome }),
      ...(blocked !== undefined && { blocked }),
      error: lastError,
    });
    const judged = judgeProgress(progress, failure);
    if (judged.stop !== null) {
      return noProgressHalt(ctx, state, {
        task,
        stop: judged.stop,
        failure,
        answers: progress?.answers ?? 0,
        lastError,
        attempts,
        handBack,
      });
    }

    const snapshot = attemptSnapshot ?? taskStartSnapshot;
    const changedFiles = await attemptChangedFiles(ctx.workspaceDir, snapshot);
    const reason: ConsultReason = blocked !== undefined ? 'blocked' : 'failed';
    const seat = consultSeat(task);
    const consult = await requestConsult(
      {
        projectDir: ctx.projectDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: ctx.sessionId,
        bus: ctx.bus,
        config: ctx.config,
        planner: ctx.planner,
        reviewer: ctx.reviewer,
        state,
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
        onStateChange: (next) => {
          state = next;
        },
      },
      {
        task,
        reason,
        failingOutput: lastError,
        report: blocked ?? null,
        progress: judged.next,
      },
    );
    if ('error' in consult) throw consult.error;

    const applied = await applyConsultAnswer(
      {
        projectDir: ctx.projectDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: ctx.sessionId,
        bus: ctx.bus,
        config: ctx.config,
        validator: ctx.validator,
        callbacks: ctx.callbacks,
        sinks: ctx.sinks,
        state,
        seat,
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
        changedFiles,
        taskStartSnapshot: ctx.taskStartSnapshot,
        onStateChange: (next) => {
          state = next;
        },
      },
      task,
      consult.answer,
      snapshot,
    );

    // The consult replaced or split the brief; the task loop dispatches the new current task.
    if (applied.action === 'rewrite-task' || applied.action === 'split-task') {
      return {
        state,
        result: failedRetry(attempts, { lastError, ...(handBack !== undefined && { handBack }) }),
      };
    }
    if (applied.action === 'completed') {
      return {
        state,
        result: {
          completed: true,
          method: 'consulted',
          attempts,
          durationMs: applied.durationMs,
          ...(applied.bookedFiles.length > 0 && { changedFiles: applied.bookedFiles }),
        },
      };
    }
    if (applied.action === 'skipped') {
      return { state, result: { completed: false, method: 'skipped', attempts } };
    }
    if (applied.action === 'correction') {
      answer = applied.answer;
      continue;
    }
    if (applied.action === 'failed') {
      lastError = applied.reason;
      blocked = undefined;
      checks = applied.checks;
      callOutcome = undefined;
      continue;
    }

    const instructions = guidanceInstructions(applied.instructions, applied.context);
    const halted = await attempt(consultAttemptError({ lastError, instructions, seat }), false);
    if (halted) return halted;
  }
}
