import type { EngineEvent } from '../../../engine/events/types.js';
import { _eventsInternal, mergeEventLog } from '../events.js';
import { _lifecycleInternal, lifecycleStore } from '../lifecycle.js';
import { updateOperations } from '../operations/reducer.js';
import { _operationsInternal } from '../operations/state.js';
import { _runViewInternal, runViewStore } from '../run-view.js';
import { reduceRunView } from '../../../core/run-view/reduce.js';
import { _tasksInternal } from '../tasks.js';
import { _tokensInternal, updateTokens } from '../tokens.js';
import { reduceLifecycle, reduceTasks } from './event.js';
import { resetWorkflowHistory } from './reset.js';

// Hydration counterpart of addEvent: the same reducers, folded over a replayed log and committed
// once per store. Replayed history replaces the run's facts and preserves local stop and prompt
// state. `cost_update` keeps addEvent's tokens-only path, so a replayed log records no phase
// for a phase whose only event was a cost update. The post-cancel gate addEvent applies is
// deliberately absent — a load rebuilds the lifecycle rather than running inside one. The view and
// the lifecycle fold together, view first, as addEvent folds them: the lifecycle reads each phase
// change from the view.
export function loadEvents(events: EngineEvent[]): void {
  resetWorkflowHistory();
  const reduced = events.filter((event) => event.type !== 'cost_update');
  let view = runViewStore.get();
  let lifecycle = lifecycleStore.get();
  for (const event of reduced) {
    const next = reduceRunView(view, event);
    lifecycle = reduceLifecycle(lifecycle, event, next.phase !== view.phase);
    view = next;
  }

  _eventsInternal.set((state) => ({ ...state, events: mergeEventLog(reduced) }));
  _tasksInternal.set((state) => reduced.reduce(reduceTasks, state));
  _tokensInternal.set((state) => events.reduce(updateTokens, state));
  _lifecycleInternal.set(lifecycle);
  _operationsInternal.set((state) => reduced.reduce(updateOperations, state));
  _runViewInternal.set(view);
}
