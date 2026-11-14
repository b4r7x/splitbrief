import { continueRunCommand } from '../../../core/recovery/resume-command.js';
import { readRunRecord } from '../../../core/sessions/run/record-io.js';
import { warnStderr } from '../../../lib/warn.js';
import { type RouteData, routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import {
  flushSessionDrafts,
  leaveWasRefusedHere,
  reportDraftNotSaved,
  discardPendingSessionDrafts,
  nameDraftsNotRemoved,
} from '../../../stores/ui/session-drafts.js';
import { departureStore, type Departure } from '../../../stores/workflow/departure.js';
import { toErrorMessage } from '../../../utils/format/errors.js';

/** Whether the screen moved to another run since the departure was asked for: it is stale then. */
export function leftOrigin(origin: RouteData): boolean {
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
export function leave(departure: Departure | null): void {
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
export function departAfterApply(apply: Promise<void>, origin: RouteData): void {
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
