import type { EngineEvent } from '../../../engine/events/types.js';
import { _eventsInternal, mergeEventLog } from '../events.js';
import { _lifecycleInternal } from '../lifecycle.js';
import { updateOperations } from '../operations/reducer.js';
import { _operationsInternal } from '../operations/state.js';
import { _tasksInternal } from '../tasks.js';
import { _tokensInternal, updateTokens } from '../tokens.js';
import { _modeAdviceInternal, updateModeAdvice } from '../mode-advice.js';
import { reduceLifecycle, reduceTasks } from './event.js';
import { resetWorkflow } from './reset.js';

// Hydration counterpart of addEvent: the same reducers, folded over a replayed log and committed
// once per store. The run being loaded replaces whatever was on screen, so every workflow store is
// reset first. `cost_update` keeps addEvent's tokens-only path, so a replayed log records no phase
// for a phase whose only event was a cost update. The post-cancel gate addEvent applies is
// deliberately absent — a load rebuilds the lifecycle rather than running inside one.
export function loadEvents(events: EngineEvent[]): void {
  resetWorkflow();
  const reduced = events.filter((event) => event.type !== 'cost_update');

  _eventsInternal.set((state) => ({ ...state, events: mergeEventLog(reduced) }));
  _tasksInternal.set((state) => reduced.reduce(reduceTasks, state));
  _tokensInternal.set((state) => events.reduce(updateTokens, state));
  _lifecycleInternal.set((state) => reduced.reduce(reduceLifecycle, state));
  _operationsInternal.set((state) => reduced.reduce(updateOperations, state));
  _modeAdviceInternal.set((state) => reduced.reduce(updateModeAdvice, state));
}
