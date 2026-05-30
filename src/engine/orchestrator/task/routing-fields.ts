import type { EngineEvent } from '../../events/types.js';
import type { RoutingDecision } from '../context-routing/types.js';

export type RoutingEventFields = Pick<
  RoutingDecision,
  | 'fit'
  | 'estimatedTokens'
  | 'untruncatedEstimatedTokens'
  | 'contextLength'
  | 'currentCodeTruncated'
  | 'currentCodeContextMode'
  | 'costPosture'
  | 'reason'
>;

type RoutingPayloadFields = Pick<
  Extract<EngineEvent, { type: 'task_started' | 'task_tokens' }>,
  | 'contextFit'
  | 'estimatedTokens'
  | 'untruncatedEstimatedTokens'
  | 'contextLength'
  | 'currentCodeTruncated'
  | 'currentCodeContextMode'
  | 'costPosture'
  | 'routingReason'
>;

export function buildRoutingEventFields(decision: RoutingEventFields | undefined): {
  [K in keyof RoutingPayloadFields]?: Exclude<RoutingPayloadFields[K], undefined>;
} {
  if (decision === undefined) return {};
  return {
    contextFit: decision.fit,
    estimatedTokens: decision.estimatedTokens,
    untruncatedEstimatedTokens: decision.untruncatedEstimatedTokens,
    ...(decision.contextLength !== undefined && { contextLength: decision.contextLength }),
    currentCodeTruncated: decision.currentCodeTruncated,
    currentCodeContextMode: decision.currentCodeContextMode,
    costPosture: decision.costPosture,
    routingReason: decision.reason,
  };
}
