import type { EngineEvent } from '../../events/types.js';
import type { RoutingDecision } from './types.js';

export type RoutingEventFields = Pick<
  RoutingDecision,
  'fit' | 'currentCodeTruncated' | 'currentCodeContextMode' | 'reason'
>;

type RoutingPayloadFields = Pick<
  Extract<EngineEvent, { type: 'task_started' | 'task_settled' }>,
  'contextFit' | 'currentCodeTruncated' | 'currentCodeContextMode' | 'routingReason'
>;

export function buildRoutingEventFields(decision: RoutingEventFields | undefined): {
  [K in keyof RoutingPayloadFields]?: Exclude<RoutingPayloadFields[K], undefined>;
} {
  if (decision === undefined) return {};
  return {
    contextFit: decision.fit,
    currentCodeTruncated: decision.currentCodeTruncated,
    currentCodeContextMode: decision.currentCodeContextMode,
    routingReason: decision.reason,
  };
}
