import { flushSessionDrafts } from '../../stores/ui/session-drafts.js';
import { readActiveRecord } from '../../core/sessions/active-pointer.js';
import { readRunRecord } from '../../core/sessions/run-record-io.js';
import { closeRunIfOpen } from '../../engine/orchestrator/run/close.js';
import { finalizeEndedRun } from '../../engine/orchestrator/session-lifecycle/finalize.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { WORKFLOW_CANCEL_REASON_USER } from '../../engine/events/workflow-cancel.js';
import { addTuiEvent } from './tui-sink.js';
import { hydrateResume } from './resume-hydration.js';
import { configStore } from '../../stores/project/config.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { routerStore } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import type { Phase } from '../../core/schemas/enums.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { markWorkflowResumed } from '../../stores/workflow/actions/resume.js';
import { stopStore } from '../../stores/workflow/stop.js';
import type { TaskRedoRequest } from '../../core/state/build-rewind-action.js';
import type { QueueClearResult, QueueSubmissionResult } from '../../engine/orchestrator/types.js';

type AbortHandler = () => void;

interface Handlers {
  stop: () => void;
  cancel: () => void;
  resume: (text: string) => void;
  rewind: (request: TaskRedoRequest) => void;
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
let pendingSeatChange = false;
let departure: { kind: 'home' | 'quit'; run: () => void } | null = null;
let unsubscribeDeparture: (() => void) | undefined;

function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
  if (h === null) delete handlers[k];
  else handlers[k] = h;
}

export function clearAllHandlers(): void {
  unsubscribeDeparture?.();
  unsubscribeDeparture = undefined;
  departure = null;
  for (const k of Object.keys(handlers) as (keyof Handlers)[]) delete handlers[k];
  abortHandlers = [];
  pendingBoundaryInterrupt = false;
  pendingBoundaryPause = false;
  pendingSeatChange = false;
}

export function createAbortHandlerScope(): (h: AbortHandler | null) => void {
  const scope: AbortHandler[] = [];
  abortHandlers = scope;
  return (h) => {
    if (h === null) scope.pop();
    else scope.push(h);
  };
}
export const setStopHandler = (h: Handlers['stop'] | null) => setHandler('stop', h);
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
  pendingSeatChange = false;
  stopStore.reset();
}

/**
 * A seat changed under the running brief: the run pauses at the next brief boundary and
 * is re-prepared from the saved config there, so the next brief starts on the new seat.
 */
export function requestSeatChangeAtBoundary(): void {
  requestBoundaryPause();
  pendingSeatChange = true;
}

export function consumeSeatChange(): boolean {
  const pending = pendingSeatChange;
  pendingSeatChange = false;
  return pending;
}

// A stop that has nothing to stop is not announced: the byline would report a run terminating
// while no process was ever asked to.
export function requestStopNow(): boolean {
  const state = stopStore.get();
  if (state.phase === 'parked' || state.phase === 'ended') return false;
  if (state.intent !== 'none' && state.intent !== 'pause-after-brief' && state.phase !== 'failed')
    return true;
  if (!handlers.stop && abortHandlers.length === 0 && !handlers.cancel) return false;
  // Announce before calling a handler: an already-idle operation may settle synchronously.
  stopStore.request(state.intent === 'end-run' ? 'end-run' : 'stop-now');
  pendingBoundaryPause = false;
  pendingSeatChange = false;
  if (handlers.stop) handlers.stop();
  else if (!abortTurn()) requestBoundaryInterrupt();
  return true;
}

// Continuing is one path, and the run owns it: the handler it installs settles a park
// this process is holding or re-enters the run at rest, and decides which.
export function requestResume(text: string): boolean {
  const stop = stopStore.get();
  if (stop.intent !== 'none' && stop.intent !== 'pause-after-brief' && stop.phase !== 'parked') {
    feedbackStore.setMessage('Finish stopping before resuming.');
    return false;
  }
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
  const route = routerStore.get();
  if (route.screen === 'workflow' && route.execution.kind === 'at-rest') {
    const config = configStore.get().config;
    if (config === null) return false;
    try {
      const record = readRunRecord(route.run.ref);
      if (record.status.kind === 'running') return false;
      const hydrated = hydrateResume(record.ref);
      if (hydrated.kind !== 'loaded') return false;
      const active = readActiveRecord(record.ref.projectDir);
      const receipt =
        active?.kind === 'v1' && active.receipt.sessionId === record.ref.sessionId
          ? active.receipt
          : undefined;
      stopStore.request('end-run');
      const finish = async (): Promise<void> => {
        const bus = createRecoveryBus({ ...record.ref, sink: addTuiEvent });
        const closure = await closeRunIfOpen({ ...record.ref, bus }, hydrated.state);
        if (closure.closedNow) {
          bus.publish({
            type: 'workflow_cancelled',
            ts: Date.now(),
            phase: closure.state.phase,
            reason: WORKFLOW_CANCEL_REASON_USER,
          });
        }
        finalizeEndedRun({ ref: record.ref, active: receipt, config, state: closure.state });
        routerStore.updateRun({ run: readRunRecord(record.ref), execution: { kind: 'at-rest' } });
        stopStore.end();
        sessionsStore.refresh();
      };
      void finish().catch((err: unknown) => {
        stopStore.reset();
        feedbackStore.setError(toErrorMessage(err));
      });
      return true;
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
      return false;
    }
  }
  stopStore.request('end-run');
  return requestCancel();
}

function requestDeparture(kind: 'home' | 'quit', run: () => void): void {
  if (departure?.kind === 'quit' || departure?.kind === kind) return;
  const origin = routerStore.get();
  departure = { kind, run };
  unsubscribeDeparture?.();
  const complete = () => {
    const phase = stopStore.get().phase;
    const route = routerStore.get();
    const changedSession =
      origin.screen === 'workflow' &&
      (route.screen !== 'workflow' ||
        route.run.ref.projectDir !== origin.run.ref.projectDir ||
        route.run.ref.sessionId !== origin.run.ref.sessionId);
    if (phase === 'failed' || changedSession) {
      unsubscribeDeparture?.();
      unsubscribeDeparture = undefined;
      departure = null;
      return;
    }
    if (phase !== 'parked' && phase !== 'ended') return;
    unsubscribeDeparture?.();
    unsubscribeDeparture = undefined;
    const action = departure;
    departure = null;
    try {
      flushSessionDrafts();
      action?.run();
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
    }
  };
  unsubscribeDeparture = stopStore.subscribe(complete);
  // A boundary pause can still hold an engine promise. Drain it before leaving its screen.
  if (stopStore.get().phase === 'parked' && handlers.stop) {
    stopStore.request('stop-now');
    handlers.stop();
  } else if (!requestStopNow()) {
    unsubscribeDeparture?.();
    unsubscribeDeparture = undefined;
    const action = departure;
    departure = null;
    try {
      flushSessionDrafts();
      action?.run();
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
    }
  }
  complete();
}

export function requestLeaveSession(): void {
  requestDeparture('home', () => {
    overlayStore.close();
    routerStore.navigate({ to: 'home' });
  });
}

export function requestQuit(exit: () => void): void {
  requestDeparture('quit', exit);
}

export function requestRewind(request: TaskRedoRequest): boolean {
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
