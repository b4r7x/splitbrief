import { _lifecycleInternal, markLifecyclePaused } from '../lifecycle.js';

export function markWorkflowPaused(): void {
  _lifecycleInternal.set((s) => markLifecyclePaused(s));
}
