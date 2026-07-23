import { _lifecycleInternal, clearLifecycleInterrupted } from '../lifecycle.js';

export function markInterruptResumed(): void {
  _lifecycleInternal.set((s) => clearLifecycleInterrupted(s));
}
