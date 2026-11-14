import type { Phase } from '../../../core/schemas/enums.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type {
  QueueHandler,
  QueueClearResult,
  QueueSubmissionResult,
} from '../../../engine/orchestrator/types.js';
import { departureStore } from '../../../stores/workflow/departure.js';
import { stopStore } from '../../../stores/workflow/stop.js';

type AbortHandler = () => void;

interface Handlers {
  stop: () => void;
  cancel: () => void;
  /** Continues the run. A refusal comes back as its reason, and the caller shows it. */
  resume: (message: UserMessageInput) => string | undefined;
  queue: QueueHandler;
  clearQueue: () => QueueClearResult | Promise<QueueClearResult>;
  /** Answers the prompt that waits now with the text: the plan card or a question that waits. */
  waitingPrompt: (message: UserMessageInput) => void;
}

/** What the run requests hold between calls. Other files read it and write it through this file. */
interface RunRequests {
  // LIFO stack: registrars nest via try/finally, so push on set and pop on null keeps
  // the innermost live call on top without registration tokens. Each workflow run gets
  // its own scope: after a rewind aborts a run, its body can settle seconds later (the
  // SIGTERM→SIGKILL grace) and still issue its paired pop — which must drain the
  // detached old scope, not steal the replacement run's just-pushed handler.
  abortHandlers: AbortHandler[];
  pendingBoundaryInterrupt: boolean;
  pendingBoundaryPause: boolean;
  steerUnsubscribe: (() => void) | undefined;
  unsubscribeDeparture: (() => void) | undefined;
}

const handlers: Partial<Handlers> = {};
const requests: RunRequests = {
  abortHandlers: [],
  pendingBoundaryInterrupt: false,
  pendingBoundaryPause: false,
  steerUnsubscribe: undefined,
  unsubscribeDeparture: undefined,
};

/** The handlers the run installed, as a live object: a handler set or taken away later shows. */
export function runHandlers(): Readonly<Partial<Handlers>> {
  return handlers;
}

export function readRunRequests(): Readonly<RunRequests> {
  return requests;
}

export function writeRunRequests(next: Partial<RunRequests>): void {
  Object.assign(requests, next);
}

function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
  if (h === null) delete handlers[k];
  else handlers[k] = h;
}

export function clearAllHandlers(): void {
  // Only a departure that waits on this run's stop goes with it. One queued behind an Apply stays:
  // the Apply delivers it once it settles.
  if (requests.unsubscribeDeparture !== undefined) departureStore.reset();
  stopWaitingForStop();
  for (const k of Object.keys(handlers) as (keyof Handlers)[]) delete handlers[k];
  requests.abortHandlers = [];
  requests.pendingBoundaryInterrupt = false;
  requests.pendingBoundaryPause = false;
  stopStore.markSeatChange(false);
  clearPendingSteer();
}

export function clearPendingSteer(): void {
  requests.steerUnsubscribe?.();
  requests.steerUnsubscribe = undefined;
}

export function stopWaitingForStop(): void {
  requests.unsubscribeDeparture?.();
  requests.unsubscribeDeparture = undefined;
}

export function createAbortHandlerScope(): (h: AbortHandler | null) => void {
  const scope: AbortHandler[] = [];
  requests.abortHandlers = scope;
  return (h) => {
    if (h === null) scope.pop();
    else scope.push(h);
  };
}
export const setStopHandler = (h: Handlers['stop'] | null) => setHandler('stop', h);
export const setCancelHandler = (h: Handlers['cancel'] | null) => setHandler('cancel', h);
export const setResumeHandler = (h: Handlers['resume'] | null) => setHandler('resume', h);
export const setQueueHandler = (h: Handlers['queue'] | null) => setHandler('queue', h);
export const setClearQueueHandler = (h: Handlers['clearQueue'] | null) =>
  setHandler('clearQueue', h);

/**
 * The prompt that waits now: the plan card or a question that waits. The returned function takes it
 * away again, unless a newer prompt replaced it: an older prompt can settle after the newer one
 * opened.
 */
export function setWaitingPromptHandler(h: Handlers['waitingPrompt']): () => void {
  handlers.waitingPrompt = h;
  return () => {
    if (handlers.waitingPrompt === h) delete handlers.waitingPrompt;
  };
}

export function abortTurn(): boolean {
  const top = requests.abortHandlers.at(-1);
  if (top === undefined) return false;
  top();
  return true;
}

/** This process holds a pass of the run that a stop can end. */
export function passHasSomethingToStop(): boolean {
  return (
    handlers.stop !== undefined ||
    requests.abortHandlers.length > 0 ||
    handlers.cancel !== undefined
  );
}

export async function requestEnqueue(
  message: UserMessageInput,
  phase: Phase,
): Promise<QueueSubmissionResult | null> {
  if (!handlers.queue) return null;
  return handlers.queue(message, phase);
}

export function requestClearQueue(): QueueClearResult | Promise<QueueClearResult> {
  return (
    handlers.clearQueue?.() ?? {
      status: 'unavailable',
      message: 'Queue clear is not available for this workflow.',
    }
  );
}
