import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import type { EngineEvent } from '../../events/types.js';
import { runLocalRetries } from './local-retries.js';
import { FULL_TIER, HINT_TIER, INTERMEDIATE_TIER, runEscalationTier } from './tier.js';
import type { EscalationContext, RetryResult } from './types.js';
import { failedRetry } from './types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishWarning, publishWarningFromError } from '../events.js';
import { getChangedFilesSnapshot, type ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import { raisePendingRecovery } from '../state-ops.js';
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

  const retries = await runLocalRetries(ctx, task, currentState, initialError);
  if (retries.result) return { state: retries.state, result: retries.result };

  if (ctx.signal?.aborted)
    return {
      state: retries.state,
      result: failedRetry(retries.attempts),
    };

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
