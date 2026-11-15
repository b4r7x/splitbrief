import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { nowIso } from '../../../utils/format/time.js';
import type { EngineEvent } from '../../events/types.js';
import { runPreHooks } from '../../hooks/run-pre.js';
import { publishWarning } from '../publish/notice.js';
import { haltAttempts } from '../recovery/builders/details.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/retry.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import type { WorkflowContext } from '../types.js';

/**
 * The `pre_escalation` hooks run before a red brief goes to the consult seat. A refusal halts the
 * brief Needs you, attributed to the hook, with the failure the consult would have read; the
 * halted state is returned. A brief the hooks let through returns nothing.
 */
export async function preEscalationHalt(
  ctx: Pick<
    WorkflowContext,
    'projectDir' | 'workspaceDir' | 'sessionId' | 'signal' | 'bus' | 'config' | 'implementerProfile'
  >,
  state: WorkflowState,
  task: Task,
  lastError: string,
): Promise<WorkflowState | undefined> {
  if (!ctx.config.hooks) return undefined;
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
    signal: ctx.signal,
  });
  if (pre.allow) return undefined;
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
  return raisePendingRecovery(ctx, state, issue);
}
