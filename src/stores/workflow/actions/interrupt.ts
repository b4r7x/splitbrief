import { lifecycleStore } from '../lifecycle.js';
import {
  _lifecycleInternal,
  markLifecycleCancellationRequested,
  markLifecycleInterrupted,
  markLifecycleInterruptParked,
} from '../lifecycle.js';
import { _operationsInternal } from '../operations/state.js';
import { markOperationsCancellationRequested } from '../operations/reducer.js';

export interface CancellationIntent {
  ts?: number;
  reason?: string;
}

export function markCancellationRequested(intent: CancellationIntent = {}): boolean {
  const lifecycle = lifecycleStore.get();
  if (lifecycle.cancelled) return false;
  const cancellation = {
    ts: intent.ts ?? Date.now(),
    reason: intent.reason ?? 'user_cancelled',
  };
  _operationsInternal.set((s) => markOperationsCancellationRequested(s, cancellation));
  _lifecycleInternal.set((s) => markLifecycleCancellationRequested(s, cancellation));
  return true;
}

export function markInterruptRequested(): boolean {
  if (lifecycleStore.get().status !== 'running') return false;
  _lifecycleInternal.set((s) => markLifecycleInterrupted(s));
  return true;
}

export function markInterruptParked(): void {
  _lifecycleInternal.set((s) => markLifecycleInterruptParked(s));
}
