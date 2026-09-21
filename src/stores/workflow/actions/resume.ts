import {
  _lifecycleInternal,
  clearLifecycleInterrupted,
  clearLifecyclePaused,
} from '../lifecycle.js';

export function markInterruptResumed(): void {
  _lifecycleInternal.set((s) => clearLifecycleInterrupted(s));
}

export function markWorkflowResumed(): void {
  _lifecycleInternal.set((s) => clearLifecyclePaused(s));
}
