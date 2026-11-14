import { type Section, isSettledSection } from '../../../../core/sections/types.js';
import { WORKSPACE_KEPT_CODE } from '../../../../core/sessions/workspace-notice.js';
import type { EngineEventOf, EngineEvent } from '../../../../engine/events/types.js';
import { COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT } from '../activity/batch-model.js';
import { isTranscriptRowlessEvent } from '../event-rows/visibility.js';
import {
  endedImplementerAttempts,
  endedCallActivity,
  retriedImplementerAttempts,
  reissuedPlannerCallDiagnostics,
  heldConsultAnswers,
} from './ended-calls.js';
import {
  automaticRecoveryFolds,
  sameHeader,
  joinsRecovery,
  restatesHalt,
} from './recovery-folds.js';
import type {
  SettledTranscriptSection,
  TranscriptWalkStep,
  RunnerActivityBatch,
  RecoveryFold,
  CheckEvent,
} from './types.js';

export function settledTaskStartedEvent(
  section: SettledTranscriptSection,
): EngineEventOf<'task_started'> | undefined {
  return section.items.find(
    (event): event is EngineEventOf<'task_started'> =>
      event.type === 'task_started' &&
      section.type === 'completed-task' &&
      event.taskId === section.summary.id,
  );
}

// The single traversal both the projection and the clickable-action builders consume, so the
// consecutive-`runner_call_activity` batching stays byte-identical between rendered rows and their
// click targets. A batch closes on a call-id change, a settled section boundary, any non-rowless
// event (yielded before that event), or the end of the transcript; row-less events never split it.
// A recovery folds the same way: its prompt or its selection opens the fold, and the selection,
// the reset and the outcome of that issue join it until another row-producing event closes it.
// Its seat switch and a correction typed with the choice wait for the fold to close,
// then follow the Recovery row they belong to in log order. A resume that a recovery answer
// started shows no row: the Recovery row says how the run went on.
// A prompt the error row before it already states opens nothing. A brief its recovery restarted
// keeps the one header it opened with: the Recovery row already says it went back to pending.
// A seat switch folds one matching reconciliation notice before the next run starts or resumes.
// A workspace kept for Continue drops out once the run continues or a close (End run, Discard or
// Apply) lets it go; a later stop that keeps it again shows its own notice. A crew change at a
// boundary that carried the run on by itself shows neither its park nor its resume; a park it did
// not carry on reads as the stop it is. A batch of a call that
// has ended says so, so no batch of a stopped or finished call carries the live mark. A review opens
// with its heading while it runs and keeps it once it settles, so no row appears above its rows.
// A BUILD attempt that a network or server retry follows shows no failed row: the status line says the call goes on.
// A planner call that the run issues again on a fresh session shows no error and no warning: the session log keeps them.
// A consult rewrite or split shows its row once the brief is replaced or split; the guard question replaces a held one.
// In a review, a run of more than three check rows yields one check group. It closes where a batch
// closes, row-less events never split it, and only a run that ends the transcript is open.
export function* walkTranscript(
  sections: readonly Section<EngineEvent>[],
): Generator<TranscriptWalkStep> {
  const automatic = automaticRecoveryFolds(sections);
  let workspaceNotice: EngineEventOf<'warning'> | undefined;
  const carriedOn = new Set<EngineEvent>();
  const answeredResumes = new Set<EngineEvent>();
  let recoveryAnswerMark = false;
  let seatChangePark: EngineEventOf<'turn_interrupted'> | undefined;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'warning' && event.code === WORKSPACE_KEPT_CODE) workspaceNotice = event;
      if (event.type === 'workflow_resumed' || event.type === 'workspace_closed')
        workspaceNotice = undefined;
      if (event.type === 'recovery_action_selected') recoveryAnswerMark = true;
      if (
        event.type === 'workflow_cancelled' ||
        event.type === 'turn_interrupted' ||
        event.type === 'recovery_action_failed'
      )
        recoveryAnswerMark = false;
      if (event.type === 'turn_interrupted' || event.type === 'workflow_cancelled')
        seatChangePark =
          event.type === 'turn_interrupted' && event.cause === 'seat-change' ? event : undefined;
      if (event.type !== 'workflow_resumed') continue;
      if (recoveryAnswerMark) {
        answeredResumes.add(event);
        recoveryAnswerMark = false;
      }
      if (event.cause === 'seat-change') {
        carriedOn.add(event);
        if (seatChangePark !== undefined) carriedOn.add(seatChangePark);
      }
      seatChangePark = undefined;
    }
  }
  const endedAttempts = endedImplementerAttempts(sections);
  const endedActivity = endedCallActivity(sections);
  const retriedAttempts = retriedImplementerAttempts(sections);
  const reissuedCalls = reissuedPlannerCallDiagnostics(sections);
  const heldAnswers = heldConsultAnswers(sections);
  let activityBatch: RunnerActivityBatch | null = null;
  let recovery: RecoveryFold | null = null;
  let afterRecovery: Extract<TranscriptWalkStep, { kind: 'event' }>[] = [];
  let checkRun: { event: CheckEvent; globalIndex: number }[] = [];
  let lastRowEvent: EngineEvent | null = null;
  let openHeader: EngineEventOf<'task_started'> | null = null;
  let restatedPrompt: EngineEventOf<'recovery_prompted'> | null = null;
  let settledContext: { settledSection?: SettledTranscriptSection } = {};

  function* flush(open = false): Generator<TranscriptWalkStep> {
    if (activityBatch !== null)
      yield {
        kind: 'activity-batch',
        batch: activityBatch,
        callEnded: endedActivity.has(activityBatch.lastEvent),
        ...settledContext,
      };
    if (recovery !== null) yield { kind: 'recovery', recovery, ...settledContext };
    yield* afterRecovery;
    const [firstCheck] = checkRun;
    if (firstCheck !== undefined && checkRun.length > COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT)
      yield {
        kind: 'check-group',
        firstIndex: firstCheck.globalIndex,
        checks: checkRun.map(({ event }) => event),
        open,
        ...settledContext,
      };
    else
      for (const { event, globalIndex } of checkRun)
        yield { kind: 'event', event, globalIndex, ...settledContext };
    activityBatch = null;
    recovery = null;
    afterRecovery = [];
    checkRun = [];
  }

  for (const section of sections) {
    const latestHeaders = new Map<string, EngineEventOf<'task_started'>>();
    for (const event of section.items) {
      if (event.type !== 'task_started') continue;
      const header = latestHeaders.get(event.taskId);
      if (header === undefined || !sameHeader(header, event))
        latestHeaders.set(event.taskId, event);
    }
    const review =
      section.type === 'active-review'
        ? section.review
        : section.type === 'settled-stage' && section.summary.stage === 'review'
          ? section.summary
          : undefined;
    if (isSettledSection(section) || review !== undefined) {
      yield* flush();
      lastRowEvent = null;
    }
    settledContext = isSettledSection(section) ? { settledSection: section } : {};
    const started = isSettledSection(section) ? settledTaskStartedEvent(section) : undefined;
    if (isSettledSection(section)) openHeader = started ?? null;
    if (review !== undefined) {
      yield {
        kind: 'review-heading',
        startIndex: section.startIndex,
        review,
        items: section.items,
      };
    } else if (isSettledSection(section)) {
      yield { kind: 'settled', section };
    }
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      const folded = automatic.recoveries.get(event);
      if (folded !== undefined) {
        yield* flush();
        yield { kind: 'recovery', recovery: folded, ...settledContext };
        lastRowEvent = event;
        continue;
      }
      if (
        automatic.hidden.has(event) ||
        endedAttempts.has(event) ||
        carriedOn.has(event) ||
        answeredResumes.has(event) ||
        retriedAttempts.has(event) ||
        reissuedCalls.has(event) ||
        heldAnswers.has(event)
      )
        continue;
      if (
        event.type === 'warning' &&
        event.code === WORKSPACE_KEPT_CODE &&
        event !== workspaceNotice
      )
        continue;
      if (
        isSettledSection(section) &&
        (event === started ||
          event.type === 'implementer_generate_running' ||
          (section.type === 'completed-task' &&
            (event.type === 'task_skipped' || event.type === 'task_full_fail') &&
            event.taskId === section.summary.id))
      )
        continue;
      if (isTranscriptRowlessEvent(event)) {
        yield { kind: 'event', event, globalIndex, ...settledContext };
        continue;
      }
      if (event.type === 'runner_call_activity') {
        if (activityBatch !== null && activityBatch.callId === event.callId) {
          activityBatch.events.push(event);
          activityBatch.lastEvent = event;
        } else {
          yield* flush();
          lastRowEvent = null;
          activityBatch = {
            callId: event.callId,
            firstIndex: globalIndex,
            events: [event],
            lastEvent: event,
          };
        }
        continue;
      }

      if (
        event.type === 'seat_switched' &&
        recovery !== null &&
        recovery.resolved === undefined &&
        recovery.seatSwitch === undefined &&
        recovery.selected?.action === 'switch-seat' &&
        recovery.selected.seat === event.seat &&
        recovery.selected.reason === event.cause &&
        recovery.selected.phase === event.phase
      ) {
        recovery.seatSwitch = event;
        afterRecovery.push({ kind: 'event', event, globalIndex, ...settledContext });
        continue;
      }
      if (
        event.type === 'user_message' &&
        recovery !== null &&
        recovery.selected !== undefined &&
        recovery.resolved === undefined
      ) {
        afterRecovery.push({ kind: 'event', event, globalIndex, ...settledContext });
        continue;
      }
      if (recovery !== null && joinsRecovery(recovery, event)) continue;
      if (event.type === 'full_suite' && review !== undefined) {
        if (checkRun.length === 0) yield* flush();
        checkRun.push({ event, globalIndex });
        lastRowEvent = event;
        continue;
      }
      yield* flush();
      if (event.type === 'recovery_prompted' && restatesHalt(lastRowEvent, event)) {
        restatedPrompt = event;
        continue;
      }
      if (
        event.type === 'recovery_prompted' ||
        event.type === 'recovery_action_selected' ||
        event.type === 'recovery_resolved'
      ) {
        recovery = { firstIndex: globalIndex, issueId: event.issueId };
        if (restatedPrompt?.issueId === event.issueId) {
          recovery.prompted = restatedPrompt;
          recovery.haltAlreadyShown = true;
        }
        restatedPrompt = null;
        joinsRecovery(recovery, event);
        lastRowEvent = event;
        continue;
      }
      if (event.type === 'task_started') {
        if (openHeader !== null && sameHeader(openHeader, event)) continue;
        openHeader = event;
      }
      lastRowEvent = event;
      yield {
        kind: 'event',
        event,
        globalIndex,
        ...settledContext,
        ...(automatic.switches.has(event) && { causeInRecovery: true }),
        ...(event.type === 'task_started' &&
          latestHeaders.get(event.taskId) !== event && { historicalTaskHeader: true }),
      };
    }
    if (isSettledSection(section)) {
      yield* flush();
      if (section.type === 'settled-stage' && section.summary.stage === 'review')
        yield { kind: 'settled-end', section };
      lastRowEvent = null;
      openHeader = null;
    }
  }
  yield* flush(true);
}
