import type { Phase } from '../../core/schemas/enums.js';
import { addEvent, markCancelled } from '../../stores/workflow/actions.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { resolveAttachment } from './attach-resolver.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';

export type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };

interface Handlers {
  abort: () => void;
  cancel: () => void;
  rewind: (request: RewindTarget) => void;
  queue: (text: string, phase: Phase) => void;
  clearQueue: () => number;
}

const handlers: Partial<Handlers> = {};

export function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
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
export const setClearQueueHandler = (h: Handlers['clearQueue'] | null) => setHandler('clearQueue', h);

export function abortTurn(): boolean {
  if (!handlers.abort) return false;
  handlers.abort();
  return true;
}

export function requestCancel(): boolean {
  const mutated = markCancelled();
  if (!mutated) return false;
  handlers.cancel?.();
  return true;
}

export function requestRewind(request: RewindTarget): boolean {
  if (!handlers.rewind) return false;
  handlers.rewind(request);
  return true;
}

export function requestEnqueue(text: string, phase: Phase): boolean {
  if (!handlers.queue) return false;
  handlers.queue(text, phase);
  return true;
}

export function requestClearQueue(): number {
  if (handlers.clearQueue) return handlers.clearQueue();
  const depth = lifecycleStore.get().queueDepth;
  if (depth > 0) {
    addEvent({ type: 'queue_cleared', ts: Date.now(), phase: lifecycleStore.get().phase, count: depth });
  }
  return depth;
}

export function requestAttach(path: string, projectDir: string): { ok: true; resolvedPath: string } | { ok: false; reason: string } {
  const result = resolveAttachment({ input: path, projectDir });
  if (!result.ok) return { ok: false, reason: result.reason };
  attachmentsStore.add(result.attachment);
  return { ok: true, resolvedPath: result.attachment.path };
}

export function requestDetach(id?: string): boolean {
  const pending = attachmentsStore.peek();
  if (pending.length === 0) return false;
  if (id) {
    const match = pending.find(a => a.id === id || a.path.endsWith(id));
    if (!match) return false;
    attachmentsStore.remove(match.id);
    return true;
  }
  attachmentsStore.remove(pending[pending.length - 1]!.id);
  return true;
}
