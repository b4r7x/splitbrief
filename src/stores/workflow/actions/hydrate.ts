import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../core/queue/state.js';
import { _lifecycleInternal } from '../lifecycle/state.js';
import type { LifecycleState } from '../lifecycle/types.js';
import { _runViewInternal } from '../run-view.js';
import { settleReviewNone, settleRunView } from '../../../core/run-view/settle.js';

/**
 * The saved state, laid over the stores the replayed log already rebuilt. The log is the narrative
 * and the state is the record of where the run stands, so the state supplies the phase, the halt, and the brief list. A run read back from disk is at
 * rest — it never claims to be running, whatever the last event on the log happened to be.
 * `reviewNone` is REVIEW None in the config the next pass runs on.
 */
export function hydrateFromState(state: WorkflowState, reviewNone: boolean): void {
  _runViewInternal.set((view) => settleRunView(view, state, reviewNone));
  _lifecycleInternal.set((current) => lifecycleFromState(current, state));
}

/** REVIEW moved while a halt waits on a live run: the run stays as it is and only the halt reads anew. */
export function updateWaitingHalt(state: WorkflowState, reviewNone: boolean): void {
  _runViewInternal.set((view) => settleReviewNone(view, state, reviewNone));
}

function lifecycleFromState(current: LifecycleState, state: WorkflowState): LifecycleState {
  const startedAt = timestampFromIso(state.startedAt);
  const queuedMessageIds = new Set(
    state.messageQueue.filter(isQueuedMessagePendingFirstDelivery).map((message) => message.id),
  );
  const base = {
    interruptParked: false,
    cancelled: false,
    queueDepth: queuedMessageIds.size,
    queuedMessageIds,
    steerableCall: null,
    stall: null,
    retry: null,
    lastRunnerEventTs: current.lastRunnerEventTs ?? null,
    briefClock: current.briefClock ?? null,
    startedAt,
    reason: null,
    restored: true,
  } as const;
  if (state.phase === 'complete') {
    return {
      ...base,
      status: 'complete',
      endedAt: state.completedAt === undefined ? null : timestampFromIso(state.completedAt),
      durationMs: null,
    };
  }
  return { ...base, status: 'paused', endedAt: null, durationMs: null };
}

function timestampFromIso(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
