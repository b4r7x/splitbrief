import type { Phase } from '../../core/schemas/enums.js';
import { markCancellationRequested } from '../../stores/workflow/actions.js';
import type { RewindTarget } from '../../core/state/build-rewind-action.js';
import type { QueueClearResult, QueueSubmissionResult } from '../../engine/orchestrator/types.js';

export type { RewindTarget };

interface Handlers {
  abort: () => void;
  cancel: () => void;
  rewind: (request: RewindTarget) => void;
  queue: (text: string, phase: Phase) => QueueSubmissionResult | Promise<QueueSubmissionResult>;
  clearQueue: () => QueueClearResult;
}

const handlers: Partial<Handlers> = {};

function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
  if (h === null) delete handlers[k];
  else handlers[k] = h;
}

export function clearAllHandlers(): void {
  for (const k of Object.keys(handlers) as (keyof Handlers)[]) delete handlers[k];
}

export const setAbortHandler = (h: Handlers['abort'] | null) => setHandler('abort', h);
export const setCancelHandler = (h: Handlers['cancel'] | null) => setHandler('cancel', h);
export const setRewindHandler = (h: Handlers['rewind'] | null) => setHandler('rewind', h);
export const setQueueHandler = (h: Handlers['queue'] | null) => setHandler('queue', h);
export const setClearQueueHandler = (h: Handlers['clearQueue'] | null) =>
  setHandler('clearQueue', h);

export function abortTurn(): boolean {
  if (!handlers.abort) return false;
  handlers.abort();
  return true;
}

export function requestCancel(): boolean {
  const mutated = markCancellationRequested();
  if (!mutated) return false;
  handlers.cancel?.();
  return true;
}

export type InterruptResult = 'turn' | 'workflow' | 'none';

export function interruptTurn(): InterruptResult {
  if (abortTurn()) return 'turn';
  if (requestCancel()) return 'workflow';
  return 'none';
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

export function requestClearQueue(): QueueClearResult {
  return (
    handlers.clearQueue?.() ?? {
      status: 'unavailable',
      message: 'Queue clear is not available for this workflow.',
    }
  );
}
