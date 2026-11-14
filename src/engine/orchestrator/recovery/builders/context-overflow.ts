import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { RoutingDecision } from '../../context-routing/types.js';
import { haltActions, chooseRecommended } from './actions.js';
import { taskFiles } from './details.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';

export interface ContextOverflowRecoveryOptions extends RecoveryBuilderBase {
  task: Task;
  routingDecision?: RoutingDecision | undefined;
  phase?: Phase | undefined;
  selectedImplementerProfile?: string | undefined;
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  routingReason?: string | undefined;
}

function contextDetails(opts: {
  estimatedTokens?: number | undefined;
  untruncatedEstimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  routingReason?: string | undefined;
}): string[] {
  return [
    opts.estimatedTokens !== undefined
      ? `Estimated prompt: ${opts.estimatedTokens} tokens`
      : undefined,
    opts.untruncatedEstimatedTokens !== undefined
      ? `Untruncated estimate: ${opts.untruncatedEstimatedTokens} tokens`
      : undefined,
    opts.contextLength !== undefined ? `Context limit: ${opts.contextLength} tokens` : undefined,
    opts.routingReason !== undefined ? `Routing: ${opts.routingReason}` : undefined,
  ].filter((detail) => detail !== undefined);
}

function rejectedProfileDetails(routing: RoutingDecision | undefined): string[] {
  if (!routing || routing.rejected.length === 0) return [];
  const rejected = routing.rejected
    .map((profile) => `${profile.profile}: ${profile.reason}`)
    .join('; ');
  return [`Rejected profiles: ${rejected}`];
}

export function buildContextOverflowRecoveryIssue(
  opts: ContextOverflowRecoveryOptions,
): RecoveryIssue {
  const phase = opts.phase ?? 'implementing';
  const routing = opts.routingDecision;
  const estimatedTokens = opts.estimatedTokens ?? routing?.estimatedTokens;
  const untruncatedEstimatedTokens =
    opts.untruncatedEstimatedTokens ?? routing?.untruncatedEstimatedTokens;
  const contextLength = opts.contextLength ?? routing?.contextLength;
  const routingReason = opts.routingReason ?? routing?.reason;
  const selectedImplementerProfile = opts.selectedImplementerProfile ?? routing?.selectedProfile;
  const actions = haltActions('context-overflow', [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: 'context-overflow',
    phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message: `${opts.task.id} does not fit a capable implementer context`,
    details: [
      ...contextDetails({
        estimatedTokens,
        untruncatedEstimatedTokens,
        contextLength,
        routingReason,
      }),
      ...rejectedProfileDetails(routing),
    ],
    selectedImplementerProfile,
    facts: compactFacts({
      estimatedTokens,
      untruncatedEstimatedTokens,
      contextLength,
      currentCodeTruncated: routing?.currentCodeTruncated,
      currentCodeContextMode: routing?.currentCodeContextMode,
      requiredWriteMode: routing?.requiredWriteMode,
      routingReason,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}
