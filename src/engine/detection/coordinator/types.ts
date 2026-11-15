import type {
  DetectionSourceId,
  DetectionSourceOutcome,
  DetectionSourceSnapshot,
} from '../types.js';

export interface PendingRequest {
  readonly source: DetectionSourceId;
  readonly contextKey: string;
  readonly scopeKey: string;
  readonly generation: number;
  readonly requestId: number;
  readonly controller: AbortController;
  cancelled: boolean;
  superseded: boolean;
  promise: Promise<DetectionSourceOutcome<object>> | undefined;
}

/** Changed in place: a load that settles late checks the active context and request of that moment. */
export interface DetectionCoordinatorState {
  readonly now: () => number;
  readonly snapshots: Map<string, DetectionSourceSnapshot<object>>;
  readonly activeContexts: Map<DetectionSourceId, string>;
  readonly pendingByScope: Map<string, PendingRequest>;
  readonly activeBySource: Map<DetectionSourceId, PendingRequest>;
  nextGeneration: number;
  nextRequestId: number;
  stopped: boolean;
}
