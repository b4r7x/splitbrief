import {
  _lifecycleInternal,
  markLifecycleWaitEnded,
  markLifecycleWaitStarted,
} from '../lifecycle.js';

export function markWaitStarted(ts = Date.now()): void {
  _lifecycleInternal.set((s) => markLifecycleWaitStarted(s, ts));
}

export function markWaitEnded(ts = Date.now()): void {
  _lifecycleInternal.set((s) => markLifecycleWaitEnded(s, ts));
}
