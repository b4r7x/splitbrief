import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { ConsultReason } from '../../../core/schemas/consult.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import type { SeatProtocolError } from '../../runners/typed-output.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import { recordNoProgressCut, runLocalRetries } from './local-retries.js';
import { runRetryStep, type BlockedReport } from './step.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { DEFAULT_LOCAL_RETRIES } from '../../../core/pipeline-spec/retries.js';
import {
  createBusTextHandler,
  publishConsultBoundSpent,
  publishError,
  publishWarning,
  publishWarningFromError,
} from '../events.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { requestConsult } from '../consult/request.js';
import { applyConsultAnswer } from '../consult/apply.js';
import { commitQueueMessagesConsulted, readQueueForConsult } from '../queue/drain.js';
import { formatMessage } from '../queue/prompt.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { captureWorkspaceSnapshot, revertedDir } from '../isolation/entry-snapshot.js';
import { buildSeatProtocolErrorRecoveryIssue } from '../recovery/builders/seat-protocol.js';
import {
  buildConsultBoundRecoveryIssue,
  consultBoundSpent,
  attemptBoundSpent,
  type ConsultBoundSpent,
} from '../recovery/builders/consult.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildSeatDownIssue,
  recoveryBuilderForRunnerOutcome,
  runnerHaltRow,
} from '../recovery/builders/task.js';
import { classifySeatFailure, type SeatFailureClassification } from '../../runners/seat-failure.js';
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
  /** The first attempt's validation failure line; the diagnosis falls back to `initialError`. */
  initialDiagnosis?: string | undefined;
  currentState: WorkflowState;
  taskStartTime?: number;
  taskStartSnapshot?: ChangedFilesSnapshot;
  dependsOnFiles?: string[];
  profileOverride?: string | undefined;
  profileOverrideTaskId?: TaskId | undefined;
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
  /** The first attempt's blocked report, when it stopped asking for a decision. */
  initialBlocked?: BlockedReport | undefined;
  /** The user's answer to a change of what the first attempt reported. */
  initialAnswer?: string | undefined;
};

/** A consult-run verify already committed the task; the run records a plain accepted completion. */
const CONSULT_COMPLETION_ACCEPTANCE: ValidationAcceptance = {
  accepted: true,
  exemptStages: [],
  blockingStages: [],
};

function handBackOf(outcome: RetryStepOutcome): string | undefined {
  return outcome.lastFailure?.handBack;
}

/**
 * A seat that cannot work halts the ladder at once: a signed-out or
 * quota-exhausted runner reproduces the same failure on every further attempt,
 * and the next rung would spend a planner call on a brief no retry can land.
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
  const failingProfile = ctx.retryProfileOverride ?? ctx.implementerProfile;
  const seatSwap = await loadSeatSwapContext({
    projectDir: ctx.projectDir,
    seat: 'build',
    runner: failure.runner,
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
    fallback: failure.runner.fallback,
    attempts: stepOutcome.attempts,
    maxAttempts: DEFAULT_LOCAL_RETRIES,
    ...(failingProfile !== undefined && { selectedImplementerProfile: failingProfile }),
    ...(seatSwap !== undefined && { seatSwap }),
    seatSwitches: stepOutcome.state.seatSwitches,
    createdAt: nowIso(),
  });
  publishError({
    bus: ctx.bus,
    phase: stepOutcome.state.phase,
    message: runnerHaltRow(issue, stepOutcome.lastError),
    ...(issue.resetAt !== undefined && { resetAt: issue.resetAt }),
  });
  const nextState = raisePendingRecovery(ctx, stepOutcome.state, issue);
  return { state: nextState, result: failedRetry(stepOutcome.attempts) };
}

/**
 * An outcome the recovery builders recognise as a runner defect halts the
 * ladder for the same reason the seat-down halt does — the next rung would
 * pay a planner call to hint around the same defect.
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
  const failingProfile = ctx.retryProfileOverride ?? ctx.implementerProfile;
  const seatSwap = await loadSeatSwapContext({
    projectDir: ctx.projectDir,
    seat: 'build',
    runner: failure.runner,
  });
  const issue = build({
    task,
    phase: stepOutcome.state.phase,
    runner: failure.runner,
    toolMessage: stepOutcome.lastError,
    attempts: stepOutcome.attempts,
    maxAttempts: DEFAULT_LOCAL_RETRIES,
    ...(failingProfile !== undefined && { selectedImplementerProfile: failingProfile }),
    ...(seatSwap !== undefined && { seatSwap }),
    ...(stepOutcome.state.workspace?.kind === 'checkout' && {
      inPlace: { revertedDir: revertedDir(ctx) },
    }),
    createdAt: nowIso(),
  });
  publishError({ bus: ctx.bus, phase: stepOutcome.state.phase, message: issue.message });
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

/** The planner could not be reached; the seat is the halt, not the brief. */
async function seatProtocolHalt(
  ctx: EscalationContext,
  state: WorkflowState,
  error: SeatProtocolError,
  attempts: number,
  handBack: string | undefined,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const seatSwap = await loadSeatSwapContext({
    projectDir: ctx.projectDir,
    seat: 'plan',
    runner: ctx.config.planner,
  });
  const issue = buildSeatProtocolErrorRecoveryIssue({
    error,
    phase: state.phase,
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });
  publishError({ bus: ctx.bus, phase: state.phase, message: issue.message });
  return {
    state: raisePendingRecovery(ctx, state, issue),
    result: failedRetry(attempts, {
      lastError: error.message,
      ...(handBack !== undefined && { handBack }),
    }),
  };
}

/** The lineage or the run is out of the budget a consult needs; the operator decides the grant. */
function consultBoundHalt(
  ctx: EscalationContext,
  task: Task,
  state: WorkflowState,
  lastDiagnosis: string,
  lastError: string,
  attempts: number,
  handBack: string | undefined,
  spent: ConsultBoundSpent,
): { state: WorkflowState; result: RetryResult } {
  const issue = buildConsultBoundRecoveryIssue({
    reason: spent.reason,
    phase: state.phase,
    task,
    lastDiagnosis,
    failingOutput: lastError,
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
    result: failedRetry(attempts, {
      lastError,
      ...(handBack !== undefined && { handBack }),
    }),
  };
}

/**
 * The ladder: one local rung with the exact errors, then the consult loop. A
 * guidance, ask-user or confirm answer spends one more implementer attempt with
 * the planner's instructions in its error block; a rewrite or a split replaces
 * the brief and hands back to the task loop; verify completes in place. The
 * user's answer to a change of what an attempt reported is delivered by the
 * next attempt, with no retry rung and no consult. Every consult and attempt
 * is counted against the lineage and the run's planner calls, and a spent
 * bound halts for the operator's grant quoting the diagnosis of the failure
 * that raised it.
 */
export async function handleRetryAndEscalation(
  opts: HandleRetryOptions,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const { wctx, initialError, currentState, taskStartTime } = opts;
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
    taskStartTime,
    taskStartSnapshot,
    dependsOnFiles: opts.dependsOnFiles ?? [],
    ...(opts.profileOverride !== undefined && { retryProfileOverride: opts.profileOverride }),
    ...(opts.profileOverrideTaskId !== undefined && {
      retryProfileOverrideTaskId: opts.profileOverrideTaskId,
    }),
  };

  let task = opts.task;
  let state = currentState;
  let lastError = initialError;
  let attempts = 0;
  let handBack: string | undefined;
  let blocked: BlockedReport | undefined = opts.initialBlocked;
  let attemptSnapshot: ChangedFilesSnapshot = taskStartSnapshot;
  let lastDiagnosis = opts.initialDiagnosis ?? initialError;
  let answer: string | undefined;

  if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };

  // An implementation that stopped to ask for a decision is not retried with
  // the same brief: the planner answers the question.
  if (blocked === undefined) {
    const retries = await runLocalRetries({
      ctx,
      task,
      state,
      lastError,
      lastDiagnosis,
      ...(opts.initialFailure !== undefined && { initialFailure: opts.initialFailure }),
      ...(opts.initialAnswer !== undefined && { answer: opts.initialAnswer }),
    });
    state = retries.state;
    task = retries.task;
    lastError = retries.lastError;
    lastDiagnosis = retries.diagnosis ?? lastError;
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
        attempts,
        maxAttempts: DEFAULT_LOCAL_RETRIES,
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
  // is the planner's or the operator's.
  wctx.bus.publish({
    type: 'task_escalating',
    ts: Date.now(),
    phase: state.phase,
    taskId: task.id,
  });

  const attempt = async (
    attemptError: string,
  ): Promise<{ state: WorkflowState; result: RetryResult } | null> => {
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };
    const spentBeforeAttempt = attemptBoundSpent(state, task);
    if (spentBeforeAttempt !== undefined) {
      return consultBoundHalt(
        ctx,
        task,
        state,
        lastDiagnosis,
        lastError,
        attempts,
        handBack,
        spentBeforeAttempt,
      );
    }

    const nextAttempts = attempts + 1;
    const outcome = await runRetryStep({
      ctx,
      task,
      state,
      lastError: attemptError,
      attempts: nextAttempts,
      method: 'consulted',
      transitionType: 'VALIDATION_PASS',
      commitSuffix: 'after consult',
      usageCategory: 'implementer',
      retryFailureFallback: 'Consult-guided retry failed to produce valid code',
      profileOverride: ctx.retryProfileOverride,
      invokeRetry: makeImplementerRetryInvoker({
        context: ctx.context,
        kind: 'consult',
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
    attempts = outcome.attempts;
    handBack = handBackOf(outcome) ?? handBack;
    attemptSnapshot = outcome.attemptSnapshot ?? attemptSnapshot;
    blocked = outcome.blocked;
    answer = outcome.answer;
    lastDiagnosis = outcome.diagnosis ?? lastError;
    state = transitionAndSave(ctx, state, { type: 'COUNT_ATTEMPT', taskId: task.id });
    recordNoProgressCut(ctx, task, state, outcome.lastFailure);
    if (outcome.result) return { state, result: outcome.result };
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };
    return runnerHalt(ctx, outcome.task, outcome);
  };

  for (;;) {
    if (ctx.signal?.aborted) return { state, result: failedRetry(attempts) };

    // The user's answer is not a consult: the next attempt delivers it.
    if (answer !== undefined) {
      const halted = await attempt(answer);
      if (halted) return halted;
      continue;
    }

    const spent = consultBoundSpent(state, task);
    if (spent !== undefined) {
      return consultBoundHalt(
        ctx,
        task,
        state,
        lastDiagnosis,
        lastError,
        attempts,
        handBack,
        spent,
      );
    }

    const snapshot = attemptSnapshot ?? taskStartSnapshot;
    const changedFiles = await attemptChangedFiles(ctx.workspaceDir, snapshot);
    const reason: ConsultReason = blocked !== undefined ? 'blocked' : 'failed';
    const queued = readQueueForConsult({
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      state,
    });
    const userText =
      queued.messages.length === 0 ? undefined : queued.messages.map(formatMessage).join('\n\n');
    const consult = await requestConsult(
      {
        projectDir: ctx.projectDir,
        workspaceDir: ctx.workspaceDir,
        sessionId: ctx.sessionId,
        bus: ctx.bus,
        planner: ctx.planner,
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
        snapshot,
        changedFiles,
        ...(userText !== undefined && { userText }),
      },
    );
    if ('error' in consult) {
      return seatProtocolHalt(ctx, state, consult.error, attempts, handBack);
    }
    if (queued.messages.length > 0) {
      state = commitQueueMessagesConsulted({
        projectDir: ctx.projectDir,
        sessionId: ctx.sessionId,
        state,
        ids: queued.messages.map((message) => message.id),
      }).state;
    }
    lastDiagnosis = consult.answer.answer.diagnosis;

    let applied = await applyConsultAnswer(
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
        ...(ctx.signal !== undefined && { signal: ctx.signal }),
        changedFiles,
        onStateChange: (next) => {
          state = next;
        },
      },
      task,
      consult.answer,
      snapshot,
    );

    if (applied.action === 'ask-user') {
      applied = await applyConsultAnswer(
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
          ...(ctx.signal !== undefined && { signal: ctx.signal }),
          onStateChange: (next) => {
            state = next;
          },
        },
        task,
        { answer: { ...applied, diagnosis: lastDiagnosis } },
        snapshot,
      );
    }

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
          acceptance: CONSULT_COMPLETION_ACCEPTANCE,
          ...(changedFiles.length > 0 && { changedFiles: [...changedFiles] }),
        },
      };
    }
    if (applied.action === 'failed') {
      lastError = applied.reason;
      blocked = undefined;
      lastDiagnosis = applied.reason;
      continue;
    }

    const instructions =
      applied.action === 'guidance'
        ? guidanceInstructions(applied.instructions, applied.context)
        : applied.action === 'ask-user'
          ? `${applied.question}\n\nWhy only you can answer: ${applied.whyOnlyUserCanAnswer}`
          : `The planner confirmed the reported decisions:\n${applied.decisions
              .map((decision) => `- ${decision.what} — ${decision.why}`)
              .join('\n')}`;
    const halted = await attempt(consultAttemptError(lastError, instructions));
    if (halted) return halted;
  }
}
