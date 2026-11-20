import type { EngineEvent } from '../../../engine/events/types.js';
import { mergeEventLog } from '../events/merge.js';
import { _eventsInternal } from '../events/state.js';
import { _lifecycleInternal, lifecycleStore } from '../lifecycle/state.js';
import { updateOperations } from '../operations/reducer.js';
import { _operationsInternal } from '../operations/state.js';
import { _runViewInternal, runViewStore } from '../run-view.js';
import { reduceRunView } from '../../../core/run-view/reduce.js';
import { reduceLifecycle } from './event.js';
import { resetWorkflowHistory } from './reset.js';

// Hydration counterpart of addEvent: the same reducers, folded over a replayed log and committed
// once per store. Replayed history replaces the run's facts and preserves local stop and prompt
// state. A load rebuilds the lifecycle. The lifecycle reads each phase change from the view.
export function loadEvents(events: EngineEvent[]): void {
  resetWorkflowHistory();
  let view = runViewStore.get();
  let lifecycle = lifecycleStore.get();
  for (const event of events) {
    const next = reduceRunView(view, event);
    lifecycle = reduceLifecycle(lifecycle, event, next.phase !== view.phase);
    view = next;
  }

  _eventsInternal.set((state) => ({ ...state, events: mergeEventLog(events) }));
  _lifecycleInternal.set(lifecycle);
  _operationsInternal.set((state) => events.reduce(updateOperations, state));
  _runViewInternal.set(view);
}
