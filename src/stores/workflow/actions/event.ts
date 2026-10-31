import type { EngineEvent } from '../../../engine/events/types.js';
import {
  lifecycleStore,
  _lifecycleInternal,
  updatePhase,
  updateQueueDepth,
  updateStall,
  type LifecycleState,
} from '../lifecycle.js';
import { _eventsInternal, mergeEvent, projectEventForTuiEventLog } from '../events.js';
import { _tokensInternal, updateTokens } from '../tokens.js';
import { _operationsInternal } from '../operations/state.js';
import { updateOperations } from '../operations/reducer.js';
import { _runViewInternal, runViewStore } from '../run-view.js';
import { reduceRunView } from '../../../core/run-view/reduce.js';

export function addEvent(event: EngineEvent): void {
  if (event.type === 'cost_update') {
    _tokensInternal.set((s) => updateTokens(s, event));
    return;
  }

  // Before the cancellation gate: a stop ends a live seat wait after it cancels the run, and a brief
  // the stop cut settles on the view.
  const previousView = runViewStore.get();
  const view = reduceRunView(previousView, event);
  _runViewInternal.set(view);

  if (lifecycleStore.get().cancelled && !acceptsEventAfterCancellation(event)) return;

  const eventForLog = projectEventForTuiEventLog(event);
  if (eventForLog !== null) {
    _eventsInternal.set((s) => ({ ...s, events: mergeEvent(s.events, eventForLog) }));
  }

  _tokensInternal.set((s) => updateTokens(s, event));

  _lifecycleInternal.set((s) => reduceLifecycle(s, event, view.phase !== previousView.phase));

  _operationsInternal.set((s) => updateOperations(s, event));
}

export function reduceLifecycle(
  state: LifecycleState,
  event: EngineEvent,
  phaseChanged: boolean,
): LifecycleState {
  const afterPhase = updatePhase(state, event, phaseChanged);
  const afterQueue = updateQueueDepth(afterPhase, event);
  return updateStall(afterQueue, event);
}

function acceptsEventAfterCancellation(event: EngineEvent): boolean {
  switch (event.type) {
    case 'workflow_cancelled':
    case 'turn_interrupted':
    case 'review_completed':
    case 'runner_call_error':
    case 'runner_call_completed':
    case 'runner_call_warning':
    case 'runner_call_usage':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
      return true;
    default:
      return false;
  }
}
