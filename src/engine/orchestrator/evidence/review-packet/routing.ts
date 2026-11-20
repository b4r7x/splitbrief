import { recoveryFactString } from '../../../../core/schemas/recovery/facts.js';
import type { ReviewPacket } from '../../../../core/schemas/review/packet.js';
import type { BuildReviewPacketOptions, PacketEvent } from './types.js';

export function buildRouting(
  opts: BuildReviewPacketOptions,
  events: PacketEvent[],
): ReviewPacket['routing'] {
  const { summary, state } = opts;
  const taskRouting = state.taskBreakdowns ?? summary.taskBreakdown ?? [];
  const routingWarnings = events.filter(
    (event) =>
      ((event.type === 'task_started' || event.type === 'task_settled') &&
        (event.message !== undefined ||
          event.outcome === 'tight' ||
          event.outcome === 'overflow')) ||
      (event.type === 'recovery_prompted' && event.routingReason !== undefined),
  );
  const issue = state.pendingRecovery;
  const reason = recoveryFactString(issue?.facts, 'routingReason');
  if (
    issue?.reason === 'context-overflow' &&
    reason !== undefined &&
    !routingWarnings.some((event) => event.issueId === issue.id)
  ) {
    routingWarnings.push({
      type: 'recovery_prompted',
      ts: issue.createdAt,
      issueId: issue.id,
      taskId: issue.taskId,
      reason: issue.reason,
      routingReason: reason,
    });
  }
  return { taskRouting, routingWarnings };
}
