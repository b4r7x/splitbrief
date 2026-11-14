import {
  discardPendingSessionDrafts,
  flushSessionDrafts,
  leaveWasRefusedHere,
  nameDraftsNotRemoved,
  reportDraftNotSaved,
} from '../../stores/ui/session-drafts.js';
import { readRunRecord } from '../../core/sessions/run/record-io.js';
import { assertCanCloseRun, endRunAtRest } from '../../engine/orchestrator/run/close.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { addTuiEvent } from './tui-sink.js';
import { readRunHistory } from './run-history.js';
import { hydrateResume } from './resume-hydration.js';
import { sessionsStore } from '../../stores/project/sessions.js';
import { routerStore, type RouteData } from '../../stores/navigation/router.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { toErrorMessage } from '../../utils/format/errors.js';
import { continueRunCommand } from '../../core/recovery/resume-command.js';
import { warnStderr } from '../../lib/warn.js';
import type { Phase } from '../../core/schemas/enums.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { markWorkflowResumed } from '../../stores/workflow/actions/resume.js';
import { stopInProgress, stopStore } from '../../stores/workflow/stop.js';
import { departureStore, type Departure } from '../../stores/workflow/departure.js';
import { activeApply } from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import type {
  BoundaryPark,
  QueueClearResult,
  QueueHandler,
  QueueSubmissionResult,
} from '../../engine/orchestrator/types.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { configStore } from '../../stores/project/config.js';
import { parkLeavesWordsUnread } from '../../core/recovery/typed-words.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { haltReadsNoWords } from '../../core/run-view/halt.js';
import { correctionActionFor, NO_CORRECTION_MESSAGE } from './recovery-prompt.js';

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

const handlers: Partial<Handlers> = {};
// LIFO stack: registrars nest via try/finally, so push on set and pop on null keeps
// the innermost live call on top without registration tokens. Each workflow run gets
// its own scope: after a rewind aborts a run, its body can settle seconds later (the
// SIGTERM→SIGKILL grace) and still issue its paired pop — which must drain the
// detached old scope, not steal the replacement run's just-pushed handler.
let abortHandlers: AbortHandler[] = [];
let pendingBoundaryInterrupt = false;
let pendingBoundaryPause = false;
let steerUnsubscribe: (() => void) | undefined;
let unsubscribeDeparture: (() => void) | undefined;
let rereadAttempt = 0;

function setHandler<K extends keyof Handlers>(k: K, h: Handlers[K] | null): void {
  if (h === null) delete handlers[k];
  else handlers[k] = h;
}

export function clearAllHandlers(): void {
  // Only a departure that waits on this run's stop goes with it. One queued behind an Apply stays:
  // the Apply delivers it once it settles.
  if (unsubscribeDeparture !== undefined) departureStore.reset();
  unsubscribeDeparture?.();
  unsubscribeDeparture = undefined;
  for (const k of Object.keys(handlers) as (keyof Handlers)[]) delete handlers[k];
  abortHandlers = [];
  pendingBoundaryInterrupt = false;
  pendingBoundaryPause = false;
  stopStore.markSeatChange(false);
  clearPendingSteer();
}

function clearPendingSteer(): void {
  steerUnsubscribe?.();
  steerUnsubscribe = undefined;
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
  const top = abortHandlers.at(-1);
  if (top === undefined) return false;
  top();
  return true;
}

export function requestCancel(): boolean {
  clearPendingSteer();
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

/**
 * What holds the run at this brief boundary, or `undefined` to carry on. A pause the operator
 * asked for wins over a seat change. Reading it clears the pending pause; the seat change is
 * spent where the run is re-prepared.
 */
export function consumeBoundaryPause(): BoundaryPark | undefined {
  const pending = pendingBoundaryPause;
  pendingBoundaryPause = false;
  if (pending) return 'pause';
  return stopStore.get().seatChange ? 'seat-change' : undefined;
}

/**
 * Whether a saved seat waits for the next review or fix brief. A pause the operator asked for
 * wins: the seat then waits for the brief boundary of that pause. Reading it clears nothing.
 */
export function seatChangeWaits(): boolean {
  return !pendingBoundaryPause && stopStore.get().seatChange;
}

export function cancelBoundaryPause(): void {
  pendingBoundaryPause = false;
  stopStore.cancelPause();
}

/**
 * A seat changed under the running run: the run stops at the next brief or review boundary and is
 * re-prepared from the saved config there, so the brief or review after it starts on the new seat.
 */
export function requestSeatChangeAtBoundary(): void {
  stopStore.markSeatChange(true);
}

/**
 * No saved seat waits any more: a re-preparation or a seat swap took every saved seat, or the saved
 * seats are the seats of the run again.
 */
export function spendSeatChange() {
  stopStore.markSeatChange(false);
}

/**
 * The run reached a brief or review boundary it stops at. `park` when no seat changed: the run
 * parks there as the operator asked. With a seat change the run stops to be re-prepared on the
 * saved seats: it `continue`s at once, or `stop`s at rest when the operator asked for the pause
 * too.
 */
export function landBoundaryPause(): 'park' | 'continue' | 'stop' {
  const { intent, seatChange } = stopStore.get();
  if (!seatChange) return 'park';
  spendSeatChange();
  return intent === 'pause-after-brief' ? 'stop' : 'continue';
}

/** This process holds a pass of the run that a stop can end. */
function passHasSomethingToStop(): boolean {
  return handlers.stop !== undefined || abortHandlers.length > 0 || handlers.cancel !== undefined;
}

// A stop that has nothing to stop is not announced: the byline would report a run terminating
// while no process was ever asked to.
export function requestStopNow(): boolean {
  clearPendingSteer();
  const state = stopStore.get();
  if (state.phase === 'parked' || state.phase === 'ended') return false;
  if (stopInProgress(state)) return true;
  if (!passHasSomethingToStop()) return false;
  // Announce before calling a handler: an already-idle operation may settle synchronously.
  stopStore.request(state.intent === 'end-run' ? 'end-run' : 'stop-now');
  pendingBoundaryPause = false;
  if (handlers.stop) handlers.stop();
  else if (!abortTurn()) requestBoundaryInterrupt();
  return true;
}

// Continuing is one path, and the run owns it: the handler it installs settles a park
// this process is holding or re-enters the run at rest, and decides which. A refusal comes back
// as its reason, and the caller shows it.
export function requestResume(message: UserMessageInput): string | undefined {
  const stop = stopStore.get();
  if (stopInProgress(stop) || stop.phase === 'failed') return 'Finish stopping before resuming.';
  if (stop.phase !== 'parked' && passHasSomethingToStop()) {
    return 'Nothing to resume: the run has not stopped.';
  }
  if (!handlers.resume) return 'Nothing to resume.';
  return handlers.resume(message);
}

/**
 * Settles a park this process is holding. False when the run is at rest, or when words wait at a
 * park no step reads them from: the continue path that follows refuses them and the park stays.
 */
export function resumeParkedRun(steer: UserMessageInput): boolean {
  if (
    steer.text !== '' &&
    stopStore.get().parked?.kind === 'boundary' &&
    parkLeavesWordsUnread(runViewStore.get().stopStep, configStore.reviewNone())
  ) {
    return false;
  }
  if (!stopStore.resume(steer)) return false;
  markWorkflowResumed();
  return true;
}

// A steer with no call to stop and no park to settle continues the run, which can refuse the text.
function steerAtRest(message: UserMessageInput): string | undefined {
  return handlers.resume ? requestResume(message) : 'Nothing to steer.';
}

/**
 * `/steer <text>` and ctrl+⏎: stop now and continue with the text as the correction. A run already
 * parked resumes here; a live call is stopped and the text held until its park lands, so a steer
 * typed during the stop race is not lost. A waiting plan card or question has nothing to stop and
 * takes the text as its change request or its answer; a halt panel that takes no typed correction
 * refuses it. A run at rest has nothing to stop and continues with the text. A refusal comes back
 * as its one reason, and the caller shows it.
 */
export function requestSteer(message: UserMessageInput): string | undefined {
  if (message.text.trim() === '') return 'Nothing to steer.';
  const stop = stopStore.get();
  if (stop.phase === 'parked') return resumeParkedRun(message) ? undefined : steerAtRest(message);
  if (stopInProgress(stop)) return 'Finish stopping before steering.';
  if (handlers.waitingPrompt) {
    // Only the halt panel's own question refuses words: the note an action asks for takes them.
    const view = runViewStore.get();
    if (
      view.halt !== null &&
      recoveryNoticeStore.get().asking &&
      correctionActionFor(view.halt.issue, haltReadsNoWords(view)) === undefined
    ) {
      return NO_CORRECTION_MESSAGE;
    }
    handlers.waitingPrompt(message);
    return undefined;
  }
  if (!passHasSomethingToStop()) return steerAtRest(message);
  clearPendingSteer();
  if (stop.intent === 'pause-after-brief') cancelBoundaryPause();
  if (!abortTurn() && !requestStopNow()) return 'Nothing to steer.';
  const resumeSteer = () => {
    if (stopStore.get().phase !== 'parked') return;
    clearPendingSteer();
    if (resumeParkedRun(message)) return;
    // The caller got its answer when the stop began, so a refusal after the park shows here.
    const refusal = steerAtRest(message);
    if (refusal !== undefined) feedbackStore.setMessage(refusal);
  };
  steerUnsubscribe = stopStore.subscribe(resumeSteer);
  resumeSteer();
  return undefined;
}

/**
 * The run on screen at rest, read again from its record. Another process can close a run this
 * screen holds, so a changed record replays its history and paints it as it stands now, and the
 * listings with it. A closed or ready run takes no stop: a park the screen still offered goes.
 */
export async function rereadRunAtRest(ref: SessionRef, signal?: AbortSignal): Promise<void> {
  const route = routerStore.get();
  if (
    route.screen !== 'workflow' ||
    route.run.ref.projectDir !== ref.projectDir ||
    route.run.ref.sessionId !== ref.sessionId
  )
    return;
  const attempt = ++rereadAttempt;
  try {
    const run = readRunRecord(ref, configStore.reviewNone());
    const publish = await readRunHistory(run);
    if (signal?.aborted || attempt !== rereadAttempt || routerStore.get() !== route) return;
    publish();
    routerStore.updateRun({ run, execution: { kind: 'at-rest' } });
    sessionsStore.refresh();
    if (run.status.kind !== 'closed' && run.status.kind !== 'ready-to-apply') return;
    const stop = stopStore.get();
    if (stop.phase === 'parked' && stop.parked?.resolve === null) stopStore.reset();
    if (overlayStore.get().active === 'stop-sheet') overlayStore.close();
  } catch (err) {
    if (signal?.aborted || attempt !== rereadAttempt || routerStore.get() !== route) return;
    feedbackStore.setError(toErrorMessage(err));
  }
}

export function requestEndRun(): boolean {
  const route = routerStore.get();
  if (route.screen === 'workflow' && route.execution.kind === 'at-rest') {
    try {
      const record = readRunRecord(route.run.ref, configStore.reviewNone());
      if (record.status.kind === 'running') return false;
      if (record.status.kind === 'closed') {
        void rereadRunAtRest(record.ref);
        return true;
      }
      const hydrated = hydrateResume(record.ref);
      if (hydrated.kind !== 'loaded') return false;
      stopStore.request('end-run');
      const finish = async (): Promise<void> => {
        const bus = createRecoveryBus({ ...record.ref, sink: addTuiEvent });
        await endRunAtRest({ ...record.ref, bus }, hydrated.state);
        routerStore.updateRun({
          run: readRunRecord(record.ref, configStore.reviewNone()),
          execution: { kind: 'at-rest' },
        });
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
  if (route.screen === 'workflow') {
    try {
      const hydrated = hydrateResume(route.run.ref);
      if (hydrated.kind === 'loaded') assertCanCloseRun(hydrated.state);
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
      return true;
    }
  }
  stopStore.request('end-run');
  return requestCancel();
}

/** Whether the screen moved to another run since the departure was asked for: it is stale then. */
function leftOrigin(origin: RouteData): boolean {
  const route = routerStore.get();
  return (
    origin.screen === 'workflow' &&
    (route.screen !== 'workflow' ||
      route.run.ref.projectDir !== origin.run.ref.projectDir ||
      route.run.ref.sessionId !== origin.run.ref.sessionId)
  );
}

/**
 * A draft that cannot be saved holds the first leave and names the cause and the file. Only a leave
 * from the screen that showed the refusal goes without it; any other screen, the same run reopened
 * included, holds again.
 */
function leave(departure: Departure | null): void {
  try {
    flushSessionDrafts();
  } catch (err) {
    if (!leaveWasRefusedHere()) {
      reportDraftNotSaved(err, true);
      return;
    }
    discardPendingSessionDrafts();
  }
  // A quit names an old draft it could not remove before its screen unmounts; a home lands first.
  if (departure?.kind === 'quit') {
    nameDraftsNotRemoved('at-exit');
    const route = routerStore.get();
    if (route.screen === 'workflow') {
      try {
        const record = readRunRecord(route.run.ref, configStore.reviewNone());
        if (record.status.kind !== 'closed') {
          warnStderr(
            `Continue this run with: ${continueRunCommand(route.run.ref.sessionId)}`,
            'at-exit',
          );
        }
      } catch (err) {
        warnStderr(toErrorMessage(err), 'at-exit');
      }
    }
  }
  try {
    departure?.run();
  } catch (err) {
    feedbackStore.setError(toErrorMessage(err));
  }
  nameDraftsNotRemoved('screen');
}

function stopWaitingForStop(): void {
  unsubscribeDeparture?.();
  unsubscribeDeparture = undefined;
}

/**
 * Apply cannot be cut, so a departure asked for while this process applies waits for it. Once it
 * settles a quit still quits; a home goes only to an applied run, so a halt never goes unseen.
 */
function departAfterApply(apply: Promise<void>, origin: RouteData): void {
  void apply.then(() => {
    const departure = departureStore.take();
    if (departure === null || leftOrigin(origin)) return;
    if (departure.kind === 'home' && origin.screen === 'workflow') {
      try {
        const status = readRunRecord(origin.run.ref, configStore.reviewNone()).status;
        if (status.kind !== 'closed' || status.as !== 'applied') return;
      } catch (err) {
        feedbackStore.setError(toErrorMessage(err));
        return;
      }
    }
    leave(departure);
  });
}

function requestDeparture(kind: Departure['kind'], run: () => void): void {
  const waiting = departureStore.get() !== null;
  if (!departureStore.queue({ kind, run })) return;
  const origin = routerStore.get();
  const apply = activeApply();
  if (apply !== undefined) {
    if (!waiting) departAfterApply(apply, origin);
    return;
  }
  stopWaitingForStop();
  const complete = () => {
    const phase = stopStore.get().phase;
    if (phase === 'failed' || leftOrigin(origin)) {
      stopWaitingForStop();
      departureStore.reset();
      return;
    }
    if (phase !== 'parked' && phase !== 'ended') return;
    stopWaitingForStop();
    leave(departureStore.take());
  };
  unsubscribeDeparture = stopStore.subscribe(complete);
  // A boundary pause can still hold an engine promise. Drain it before leaving its screen.
  if (stopStore.get().phase === 'parked' && handlers.stop) {
    stopStore.request('stop-now');
    handlers.stop();
  } else if (!requestStopNow()) {
    stopWaitingForStop();
    leave(departureStore.take());
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
