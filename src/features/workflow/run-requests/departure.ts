import { continueRunCommand } from '../../../core/recovery/resume-command.js';
import { readRunRecord } from '../../../core/sessions/run/record-io.js';
import { activeApply } from '../../../engine/orchestrator/session-lifecycle/shutdown.js';
import { warnStderr } from '../../../lib/warn.js';
import { type RouteData, routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import {
  flushSessionDrafts,
  leaveWasRefusedHere,
  reportDraftNotSaved,
  discardPendingSessionDrafts,
  nameDraftsNotRemoved,
} from '../../../stores/ui/session-drafts.js';
import { departureStore, type Departure } from '../../../stores/workflow/departure.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { runHandlers, stopWaitingForStop, writeRunRequests } from './registry.js';
import { requestStopNow } from './stop-resume.js';

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
  writeRunRequests({ unsubscribeDeparture: stopStore.subscribe(complete) });
  const handlers = runHandlers();
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
