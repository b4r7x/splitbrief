import type { TaskContextFit, CurrentCodeContextMode } from '../../events/workflow-events.js';
import type { EngineEvent } from '../../events/types.js';

export interface RoutingEventFields {
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength?: number | undefined;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  costPosture: string;
  reason: string;
}

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

export function buildRoutingEventFields(decision: RoutingEventFields | undefined): Partial<RoutingPayloadFields> {
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
