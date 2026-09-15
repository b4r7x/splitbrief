import type { Phase } from '../../core/schemas/enums.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { markWorkflowResumed } from '../../stores/workflow/actions/resume.js';
import { stopStore } from '../../stores/workflow/stop.js';
import type { RewindTarget } from '../../core/state/build-rewind-action.js';
import type { QueueClearResult, QueueSubmissionResult } from '../../engine/orchestrator/types.js';

export type { RewindTarget };

type AbortHandler = () => void;

interface Handlers {
  cancel: () => void;
  resume: (text: string) => void;
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
let pendingBoundaryPause = false;

function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
  if (h === null) delete handlers[k];
  else handlers[k] = h;
}

export function clearAllHandlers(): void {
  for (const k of Object.keys(handlers) as (keyof Handlers)[]) delete handlers[k];
  abortHandlers = [];
  pendingBoundaryInterrupt = false;
  pendingBoundaryPause = false;
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
export const setResumeHandler = (h: Handlers['resume'] | null) => setHandler('resume', h);
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

export function requestBoundaryPause(): void {
  stopStore.request('pause-after-brief');
  pendingBoundaryPause = true;
}

export function consumeBoundaryPause(): boolean {
  const pending = pendingBoundaryPause;
  pendingBoundaryPause = false;
  return pending;
}

export function cancelBoundaryPause(): void {
  pendingBoundaryPause = false;
  stopStore.reset();
}

// A stop that has nothing to stop is not announced: the byline would report a run terminating
// while no process was ever asked to.
export function requestStopNow(): boolean {
  const abortedCall = abortTurn();
  const boundaryFlagged = requestBoundaryInterrupt();
  if (!abortedCall && !boundaryFlagged) return false;
  stopStore.request('stop-now');
  return true;
}

// Continuing is one path, and the run owns it: the handler it installs settles a park
// this process is holding or re-enters the run at rest, and decides which.
export function requestResume(text: string): boolean {
  if (!handlers.resume) return false;
  handlers.resume(text);
  return true;
}

/** Settles a park this process is holding. False when the run is at rest. */
export function resumeParkedRun(steer: string): boolean {
  if (stopStore.get().phase !== 'parked') return false;
  stopStore.resume(steer);
  markWorkflowResumed();
  return true;
}

export function requestEndRun(): boolean {
  stopStore.request('end-run');
  return requestCancel();
}

// Quit is Stop now that also leaves: the exit waits for the run to park or end so the session is
// on disk before the process goes.
export function requestQuit(exit: () => void): void {
  if (!requestStopNow()) {
    exit();
    return;
  }
  stopStore.request('quit');
  const off = stopStore.subscribe(() => {
    const { phase } = stopStore.get();
    if (phase !== 'parked' && phase !== 'ended') return;
    off();
    exit();
  });
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
