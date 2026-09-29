import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { runLocalRetries } from './local-retries.js';
import { HINT_TIER, INTERMEDIATE_TIER, runEscalationTier } from './tier.js';
import type {
  EscalationContext,
  RetryAttemptFailure,
  RetryResult,
  RetryStepOutcome,
} from './types.js';
import { failedRetry } from './types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildRunnerUnauthenticatedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  recoveryBuilderForRunnerOutcome,
  routeBiggerProfileFromDecision,
  runnerHaltRow,
} from '../recovery/builders/task.js';
import { raisePendingRecovery } from '../state-ops.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { nowIso } from '../../../utils/format-time.js';

type HandleRetryOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  currentState: WorkflowState;
  taskStartTime?: number;
  taskStartSnapshot?: ChangedFilesSnapshot;
  dependsOnFiles?: string[];
  profileOverride?: string | undefined;
  profileOverrideTaskId?: TaskId | undefined;
  undeclaredWrites?: 'reject' | 'gate' | undefined;
  /** How the first attempt ended, when it ended on a machine outcome. */
  initialFailure?: RetryAttemptFailure | undefined;
};

function handBackOf(outcome: RetryStepOutcome): string | undefined {
  return outcome.lastFailure?.handBack;
}

/**
 * A signed-out runner halts the ladder: the next rung would spend a planner
 * call on a brief no retry can land until the login is fixed. Raise the login
 * recovery and stop.
 */
function unauthenticatedHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): { state: WorkflowState; result: RetryResult } | null {
  const failure = stepOutcome.lastFailure;
  if (failure?.outcome !== 'unauthenticated') return null;
  const failingProfile = ctx.retryProfileOverride ?? ctx.implementerProfile;
  const issue = buildRunnerUnauthenticatedRecoveryIssue({
    task,
    phase: stepOutcome.state.phase,
    runner: failure.runner,
    toolMessage: stepOutcome.lastError,
    attempts: stepOutcome.attempts,
    maxAttempts: ctx.config.workflow.maxRetries,
    ...(failingProfile !== undefined && { selectedImplementerProfile: failingProfile }),
    createdAt: nowIso(),
  });
  publishError({
    bus: ctx.bus,
    phase: stepOutcome.state.phase,
    message: runnerHaltRow(issue, stepOutcome.lastError),
  });
  const nextState = raisePendingRecovery(ctx, stepOutcome.state, issue);
  return { state: nextState, result: failedRetry(stepOutcome.attempts) };
}

/**
 * A quota-exhausted runner halts the ladder for the same reason a signed-out
 * one does — the next rung would spend a planner call on a retry the quota
 * blocks anyway. The recovery names the reset time when the tool reported one
 * and offers the profile switch instead of a pointless re-login.
 */
async function usageLimitHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): Promise<{ state: WorkflowState; result: RetryResult } | null> {
  const failure = stepOutcome.lastFailure;
  if (failure?.outcome !== 'usage-limit') return null;
  const failingProfile = ctx.retryProfileOverride ?? ctx.implementerProfile;
  const routeBiggerProfile = routeBiggerProfileFromDecision(ctx.routingDecision);
  const seatSwap = await loadSeatSwapContext({
    projectDir: ctx.projectDir,
    seat: 'build',
    runner: failure.runner,
  });
  const issue = buildRunnerUsageLimitRecoveryIssue({
    task,
    phase: stepOutcome.state.phase,
    runner: failure.runner,
    toolMessage: stepOutcome.lastError,
    attempts: stepOutcome.attempts,
    maxAttempts: ctx.config.workflow.maxRetries,
    ...(failingProfile !== undefined && { selectedImplementerProfile: failingProfile }),
    ...(routeBiggerProfile !== undefined && { routeBiggerProfile }),
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });
  publishError({
    bus: ctx.bus,
    phase: stepOutcome.state.phase,
    message: runnerHaltRow(issue, stepOutcome.lastError),
    resetAt: issue.resetAt,
  });
  const nextState = raisePendingRecovery(ctx, stepOutcome.state, issue);
  return { state: nextState, result: failedRetry(stepOutcome.attempts) };
}

/**
 * An outcome the recovery builders recognise as a runner defect halts the
 * ladder for the same reason the auth and quota halts do — the next rung would
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
  const routeBiggerProfile = routeBiggerProfileFromDecision(ctx.routingDecision);
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
    maxAttempts: ctx.config.workflow.maxRetries,
    ...(failingProfile !== undefined && { selectedImplementerProfile: failingProfile }),
    ...(routeBiggerProfile !== undefined && { routeBiggerProfile }),
    ...(seatSwap !== undefined && { seatSwap }),
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
  const unauthenticated = unauthenticatedHalt(ctx, task, stepOutcome);
  if (unauthenticated) return unauthenticated;
  const defect = await runnerDefectHalt(ctx, task, stepOutcome);
  if (defect) return defect;
  return usageLimitHalt(ctx, task, stepOutcome);
}

export async function handleRetryAndEscalation(
  opts: HandleRetryOptions,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const { wctx, task, initialError, currentState, taskStartTime } = opts;
  let taskStartSnapshot = opts.taskStartSnapshot;
  if (!taskStartSnapshot) {
    try {
      taskStartSnapshot = await getChangedFilesSnapshot(wctx.projectDir);
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
    ...(opts.undeclaredWrites !== undefined && { undeclaredWrites: opts.undeclaredWrites }),
  };

  const hintCapable = ctx.planner.capabilities.supportsHintEscalation;
  // A first attempt that stopped and said why is adjudicated by the planner, not
  // answered with the same retry; without a planner that can hint, the local
  // rung keeps its one turn.
  const initialFailure = opts.initialFailure;
  const stopForPlanner =
    hintCapable &&
    initialFailure?.outcome === 'no-staged-change' &&
    initialFailure.handBack !== undefined;
  const retries: RetryStepOutcome = stopForPlanner
    ? {
        state: currentState,
        task,
        lastError: initialError,
        attempts: 0,
        lastFailure: initialFailure,
      }
    : await runLocalRetries({ ctx, task, state: currentState, lastError: initialError });
  if (retries.result) return { state: retries.state, result: retries.result };

  if (ctx.signal?.aborted)
    return {
      state: retries.state,
      result: failedRetry(retries.attempts),
    };

  const retriesHalt = await runnerHalt(ctx, retries.task, retries);
  if (retriesHalt) return retriesHalt;

  if (ctx.config.hooks) {
    const preEscalationPayload: EngineEvent = {
      type: 'task_escalating',
      ts: Date.now(),
      phase: retries.state.phase,
      taskId: task.id,
    };
    const pre = await runPreHooks(ctx.config.hooks, 'pre_escalation', preEscalationPayload, {
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
    });
    if (!pre.allow) {
      const reason = pre.reason ?? 'hook denied';
      publishWarning({
        bus: ctx.bus,
        phase: retries.state.phase,
        message: `pre_escalation blocked: ${reason}`,
      });
      const issue = buildRetryExhaustedRecoveryIssue({
        task,
        phase: retries.state.phase,
        escalationBlockedBy: reason,
        validationSummary: retries.lastError,
        attempts: retries.attempts,
        maxAttempts: ctx.config.workflow.maxRetries,
        allowRetryOverride: true,
        ...(ctx.implementerProfile !== undefined && {
          selectedImplementerProfile: ctx.implementerProfile,
        }),
        createdAt: nowIso(),
      });
      const nextState = raisePendingRecovery(ctx, retries.state, issue);
      return {
        state: nextState,
        result: failedRetry(retries.attempts),
      };
    }
  }

  const tier0 = stopForPlanner
    ? retries
    : await runEscalationTier(INTERMEDIATE_TIER, {
        ctx,
        task: retries.task,
        state: retries.state,
        lastError: retries.lastError,
        priorAttempts: retries.attempts,
      });
  if (tier0.result) return { state: tier0.state, result: tier0.result };

  if (ctx.signal?.aborted)
    return {
      state: tier0.state,
      result: failedRetry(tier0.attempts),
    };

  const tier0Halt = await runnerHalt(ctx, tier0.task, tier0);
  if (tier0Halt) return tier0Halt;

  // A skipped tier 0 returns a fresh outcome with no failure of its own, so the
  // surviving hand-back is the local rung's.
  const tier0HandBack = handBackOf(tier0) ?? handBackOf(retries);
  const tier1 = hintCapable
    ? await runEscalationTier(HINT_TIER, {
        ctx,
        task: tier0.task,
        state: tier0.state,
        lastError: tier0.lastError,
        priorAttempts: tier0.attempts,
        ...(tier0HandBack !== undefined && { handBack: tier0HandBack }),
      })
    : tier0;
  if (tier1.result) return { state: tier1.state, result: tier1.result };

  if (ctx.signal?.aborted)
    return {
      state: tier1.state,
      result: failedRetry(tier1.attempts),
    };

  const tier1Halt = await runnerHalt(ctx, tier1.task, tier1);
  if (tier1Halt) return tier1Halt;

  // The hint rung is the last one: the planner advises, it never takes the
  // brief over and writes the code itself. Exhaustion hands the brief to the
  // retry-exhausted recovery with the attempts the implementer actually spent
  // and the last rung's error, hand-back and planner answer.
  const handBack = handBackOf(tier1) ?? tier0HandBack;
  return {
    state: tier1.state,
    result: failedRetry(tier1.attempts, {
      lastError: tier1.lastError,
      ...(handBack !== undefined && { handBack }),
      ...(tier1.plannerHint !== undefined && { plannerHint: tier1.plannerHint }),
      ...(tier1.attempts > tier0.attempts && { hintRungRan: true }),
      ...(tier1.plannerVerdict !== undefined && { plannerVerdict: tier1.plannerVerdict }),
    }),
  };
}
