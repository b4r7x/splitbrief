import { _lifecycleInternal } from '../lifecycle/state.js';
import { clearLifecycleInterrupted, clearLifecyclePaused } from '../lifecycle/marks.js';

export function markInterruptResumed(): void {
  _lifecycleInternal.set((s) => clearLifecycleInterrupted(s));
}

export function markWorkflowResumed(ts = Date.now()): void {
  _lifecycleInternal.set((s) => clearLifecyclePaused(s, ts));
}
