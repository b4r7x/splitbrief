import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { runLocalRetries } from './local-retries.js';
import { FULL_TIER, HINT_TIER, INTERMEDIATE_TIER, runEscalationTier } from './tier.js';
import type { EscalationContext, RetryResult, RetryStepOutcome } from './types.js';
import { failedRetry } from './types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import {
  buildRetryExhaustedRecoveryIssue,
  buildRunnerUnauthenticatedRecoveryIssue,
  buildRunnerUsageLimitRecoveryIssue,
  routeBiggerProfileFromDecision,
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
};

/**
 * A signed-out runner halts the ladder: the next tier would silently hand
 * the task to the planner at planner prices, which is exactly the failure
 * an expired login must not cause. Raise the login recovery and stop.
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
    message: `${issue.message} (runner reported: ${stepOutcome.lastError})`,
  });
  const nextState = raisePendingRecovery(ctx, stepOutcome.state, issue);
  return { state: nextState, result: failedRetry(stepOutcome.attempts) };
}

/**
 * A quota-exhausted runner halts the ladder for the same reason a signed-out
 * one does — the next tier would silently do implementer work at planner
 * prices. The recovery names the reset time when the tool reported one and
 * offers the profile switch instead of a pointless re-login.
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
    message: `${issue.message} (runner reported: ${stepOutcome.lastError})`,
  });
  const nextState = raisePendingRecovery(ctx, stepOutcome.state, issue);
  return { state: nextState, result: failedRetry(stepOutcome.attempts) };
}

async function runnerHalt(
  ctx: EscalationContext,
  task: Task,
  stepOutcome: RetryStepOutcome,
): Promise<{ state: WorkflowState; result: RetryResult } | null> {
  const unauthenticated = unauthenticatedHalt(ctx, task, stepOutcome);
  if (unauthenticated) return unauthenticated;
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
  };

  const retries = await runLocalRetries({
    ctx,
    task,
    state: currentState,
    lastError: initialError,
  });
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
        message: `${task.id} escalation blocked by pre_escalation hook: ${reason}`,
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

  const tier0 = await runEscalationTier(INTERMEDIATE_TIER, {
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

  const tier1 = await runEscalationTier(HINT_TIER, {
    ctx,
    task: tier0.task,
    state: tier0.state,
    lastError: tier0.lastError,
    priorAttempts: tier0.attempts,
  });
  if (tier1.result) return { state: tier1.state, result: tier1.result };

  if (ctx.signal?.aborted)
    return {
      state: tier1.state,
      result: failedRetry(tier1.attempts),
    };

  const tier1Halt = await runnerHalt(ctx, tier1.task, tier1);
  if (tier1Halt) return tier1Halt;

  const tier2 = await runEscalationTier(FULL_TIER, {
    ctx,
    task: tier1.task,
    state: tier1.state,
    lastError: tier1.lastError,
    priorAttempts: tier1.attempts,
  });
  return {
    state: tier2.state,
    result: tier2.result ?? failedRetry(tier2.attempts),
  };
}
