import { _lifecycleInternal } from '../lifecycle/state.js';
import { markLifecycleWaitEnded, markLifecycleWaitStarted } from '../lifecycle/marks.js';
import { runViewStore } from '../run-view.js';

export function markWaitStarted(ts = Date.now()): void {
  _lifecycleInternal.set((s) => markLifecycleWaitStarted(s, ts));
}

export function markWaitEnded(ts = Date.now()): void {
  const { phase } = runViewStore.get();
  _lifecycleInternal.set((s) => markLifecycleWaitEnded(s, ts, phase));
}
