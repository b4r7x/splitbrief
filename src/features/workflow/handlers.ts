import type { Phase } from '../../core/schemas/enums.js';
import {
  markCancellationRequested,
  markInterruptRequested,
} from '../../stores/workflow/actions/interrupt.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import type { RewindTarget } from '../../core/state/build-rewind-action.js';
import type { QueueClearResult, QueueSubmissionResult } from '../../engine/orchestrator/types.js';

export type { RewindTarget };

type AbortHandler = () => void;

interface Handlers {
  cancel: () => void;
  rewind: (request: RewindTarget) => void;
  queue: (text: string, phase: Phase) => QueueSubmissionResult | Promise<QueueSubmissionResult>;
  clearQueue: () => QueueClearResult | Promise<QueueClearResult>;
}

const handlers: Partial<Handlers> = {};
// LIFO stack: registrars nest via try/finally, so push on set and pop on null keeps
// the innermost live call on top without registration tokens. Each workflow run gets
// its own scope: after a rewind aborts a run, its body can settle seconds later (the
// SIGTERM→SIGKILL grace) and still issue its paired pop — which must drain the
// detached old scope, not steal the replacement run's just-pushed handler.
let abortHandlers: AbortHandler[] = [];
let pendingBoundaryInterrupt = false;

function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
  if (h === null) delete handlers[k];
  else handlers[k] = h;
}

export function clearAllHandlers(): void {
  for (const k of Object.keys(handlers) as (keyof Handlers)[]) delete handlers[k];
  abortHandlers = [];
  pendingBoundaryInterrupt = false;
}

export function createAbortHandlerScope(): (h: AbortHandler | null) => void {
  const scope: AbortHandler[] = [];
  abortHandlers = scope;
  return (h) => {
    if (h === null) scope.pop();
    else scope.push(h);
  };
}
export const setCancelHandler = (h: Handlers['cancel'] | null) => setHandler('cancel', h);
export const setRewindHandler = (h: Handlers['rewind'] | null) => setHandler('rewind', h);
export const setQueueHandler = (h: Handlers['queue'] | null) => setHandler('queue', h);
export const setClearQueueHandler = (h: Handlers['clearQueue'] | null) =>
  setHandler('clearQueue', h);

export function abortTurn(): boolean {
  const top = abortHandlers.at(-1);
  if (top === undefined) return false;
  top();
  return true;
}

export function requestCancel(): boolean {
  const mutated = markCancellationRequested();
  if (!mutated) return false;
  handlers.cancel?.();
  return true;
}

function requestBoundaryInterrupt(): boolean {
  if (!handlers.cancel) return false;
  pendingBoundaryInterrupt = true;
  return true;
}

export function consumeBoundaryInterrupt(): boolean {
  const pending = pendingBoundaryInterrupt;
  pendingBoundaryInterrupt = false;
  return pending;
}

export type InterruptResult = 'turn' | 'workflow' | 'none';

export function interruptTurn(): InterruptResult {
  const alreadyInterrupted = lifecycleStore.get().status === 'interrupted';
  markInterruptRequested();
  if (abortTurn()) {
    return 'turn';
  }
  // Already parked at the interrupted prompt with no call in flight: planting a
  // boundary flag here would silently discard the user's next steering answer
  // (the continuation loop consumes the flag before reading the prompt).
  if (alreadyInterrupted) return 'none';
  if (requestBoundaryInterrupt()) return 'turn';
  return requestCancel() ? 'workflow' : 'none';
}

export function requestRewind(request: RewindTarget): boolean {
  if (!handlers.rewind) return false;
  handlers.rewind(request);
  return true;
}

export async function requestEnqueue(
  text: string,
  phase: Phase,
): Promise<QueueSubmissionResult | null> {
  if (!handlers.queue) return null;
  return handlers.queue(text, phase);
}

export function requestClearQueue(): QueueClearResult | Promise<QueueClearResult> {
  return (
    handlers.clearQueue?.() ?? {
      status: 'unavailable',
      message: 'Queue clear is not available for this workflow.',
    }
  );
}
