import { _lifecycleInternal, markLifecyclePaused } from '../lifecycle.js';

export function markWorkflowPaused(ts = Date.now()): void {
  _lifecycleInternal.set((s) => markLifecyclePaused(s, ts));
}
