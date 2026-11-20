import { parkLeavesWordsUnread } from '../../../core/recovery/typed-words.js';
import { haltReadsNoWords } from '../../../core/run-view/halt.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { markCancellationRequested } from '../../../stores/workflow/actions/interrupt.js';
import { markWorkflowResumed } from '../../../stores/workflow/actions/resume.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore, stopInProgress } from '../../../stores/workflow/stop.js';
import { correctionActionFor, NO_CORRECTION_MESSAGE } from '../recovery/actions.js';
import { cancelBoundaryPause, requestBoundaryInterrupt } from './boundary.js';
import {
  abortTurn,
  clearPendingSteer,
  passHasSomethingToStop,
  runHandlers,
  writeRunRequests,
} from './registry.js';

export function requestCancel(): boolean {
  clearPendingSteer();
  const mutated = markCancellationRequested();
  if (!mutated) return false;
  runHandlers().cancel?.();
  return true;
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
  writeRunRequests({ pendingBoundaryPause: false });
  const handlers = runHandlers();
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
  const handlers = runHandlers();
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
  return runHandlers().resume ? requestResume(message) : 'Nothing to steer.';
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
  const handlers = runHandlers();
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
    if (refusal !== undefined) feedbackStore.setWarning(refusal);
  };
  writeRunRequests({ steerUnsubscribe: stopStore.subscribe(resumeSteer) });
  resumeSteer();
  return undefined;
}
