import { _lifecycleInternal } from '../lifecycle/state.js';
import { markLifecyclePaused } from '../lifecycle/marks.js';

export function markWorkflowPaused(ts = Date.now()): void {
  _lifecycleInternal.set((s) => markLifecyclePaused(s, ts));
}
