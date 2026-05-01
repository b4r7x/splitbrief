import type { TaskContextFit, CurrentCodeContextMode } from '../../events/workflow-events.js';

export interface RoutingDecision {
  fit: TaskContextFit;
  estimatedTokens: number;
  untruncatedEstimatedTokens: number;
  contextLength?: number | undefined;
  currentCodeTruncated: boolean;
  currentCodeContextMode: CurrentCodeContextMode;
  costPosture: string;
  reason: string;
}

export function buildRoutingEventFields(decision: RoutingDecision | undefined): Record<string, unknown> {
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
