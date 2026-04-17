import type { Phase } from '../../types.js';
import { addEvent, markCancelled } from '../../stores/workflow/actions.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';

export type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };

type AbortHandler = () => void;
type CancelHandler = () => void;
type RewindHandler = (request: RewindTarget) => void;
type QueueHandler = (text: string, phase: Phase) => void;
type ClearQueueHandler = () => number;

let abortHandler: AbortHandler | null = null;
let cancelHandler: CancelHandler | null = null;
let rewindHandler: RewindHandler | null = null;
let queueHandler: QueueHandler | null = null;
let clearQueueHandler: ClearQueueHandler | null = null;

export function setAbortHandler(h: AbortHandler | null): void { abortHandler = h; }
export function setCancelHandler(h: CancelHandler | null): void { cancelHandler = h; }
export function setRewindHandler(h: RewindHandler | null): void { rewindHandler = h; }
export function setQueueHandler(h: QueueHandler | null): void { queueHandler = h; }
export function setClearQueueHandler(h: ClearQueueHandler | null): void { clearQueueHandler = h; }

export function clearAllHandlers(): void {
  abortHandler = null;
  cancelHandler = null;
  rewindHandler = null;
  queueHandler = null;
  clearQueueHandler = null;
}

export function abortTurn(): boolean {
  if (!abortHandler) return false;
  abortHandler();
  return true;
}

export function requestCancel(): boolean {
  const mutated = markCancelled();
  if (!mutated) return false;
  cancelHandler?.();
  return true;
}

export function requestRewind(request: RewindTarget): boolean {
  if (!rewindHandler) return false;
  rewindHandler(request);
  return true;
}

export function requestEnqueue(text: string, phase: Phase): boolean {
  if (!queueHandler) return false;
  queueHandler(text, phase);
  return true;
}

export function requestClearQueue(): number {
  if (clearQueueHandler) return clearQueueHandler();
  const depth = lifecycleStore.get().queueDepth;
  if (depth > 0) {
    addEvent({ type: 'queue-cleared', ts: Date.now(), count: depth });
  }
  return depth;
}
