import { isSettledSection } from '../../../../core/sections/types.js';
import { WORKSPACE_KEPT_CODE } from '../../../../core/sessions/workspace-notice.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT } from '../activity/batch-model.js';
import { isTranscriptRowlessEvent } from '../event-rows/visibility.js';
import { joinsRecovery, restatesHalt, sameHeader } from './recovery-folds.js';
import type {
  RecoveryFold,
  RunnerActivityEvent,
  TranscriptWalk,
  TranscriptWalkReads,
  TranscriptWalkStep,
  WalkSection,
} from './types.js';

/** Yields what the walk holds open, in log order, and empties it. */
export function* flush(
  walk: TranscriptWalk,
  reads: TranscriptWalkReads,
  open = false,
): Generator<TranscriptWalkStep> {
  const { activityBatch, recovery, checkRun, settledContext } = walk;
  if (activityBatch !== null)
    yield {
      kind: 'activity-batch',
      batch: activityBatch,
      callEnded: reads.endedActivity.has(activityBatch.lastEvent),
      ...settledContext,
    };
  if (recovery !== null) yield { kind: 'recovery', recovery, ...settledContext };
  yield* walk.afterRecovery;
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
  walk.activityBatch = null;
  walk.recovery = null;
  walk.afterRecovery = [];
  walk.checkRun = [];
}

/** One event of a section: it shows no row, joins what is open, opens a fold or gives a row. */
export function* walkEvent(
  walk: TranscriptWalk,
  reads: TranscriptWalkReads,
  scope: WalkSection,
  event: EngineEvent,
  globalIndex: number,
): Generator<TranscriptWalkStep> {
  const folded = reads.recoveries.get(event);
  if (folded !== undefined) {
    yield* flush(walk, reads);
    yield { kind: 'recovery', recovery: folded, ...walk.settledContext };
    walk.lastRowEvent = event;
    return;
  }
  if (showsNoRow(reads, scope, event)) return;
  if (isTranscriptRowlessEvent(event)) {
    yield { kind: 'event', event, globalIndex, ...walk.settledContext };
    return;
  }
  if (event.type === 'runner_call_activity') {
    yield* batchActivity(walk, reads, event, globalIndex);
    return;
  }
  if (joinsOpenRecovery(walk, event, globalIndex)) return;
  if (event.type === 'full_suite' && scope.review !== undefined) {
    if (walk.checkRun.length === 0) yield* flush(walk, reads);
    walk.checkRun.push({ event, globalIndex });
    walk.lastRowEvent = event;
    return;
  }
  yield* flush(walk, reads);
  if (opensRecovery(walk, event, globalIndex)) return;
  if (event.type === 'task_started') {
    if (walk.openHeader !== null && sameHeader(walk.openHeader, event)) return;
    walk.openHeader = event;
  }
  walk.lastRowEvent = event;
  yield {
    kind: 'event',
    event,
    globalIndex,
    ...walk.settledContext,
    ...(reads.switches.has(event) && { causeInRecovery: true }),
    ...(event.type === 'task_started' &&
      scope.latestHeaders.get(event.taskId) !== event && { historicalTaskHeader: true }),
  };
}

function showsNoRow(
  reads: TranscriptWalkReads,
  { section, started }: WalkSection,
  event: EngineEvent,
): boolean {
  if (reads.hidden.has(event)) return true;
  if (
    event.type === 'warning' &&
    event.code === WORKSPACE_KEPT_CODE &&
    event !== reads.workspaceNotice
  )
    return true;
  return (
    isSettledSection(section) &&
    (event === started ||
      event.type === 'implementer_generate_running' ||
      (section.type === 'completed-task' &&
        (event.type === 'task_skipped' || event.type === 'task_full_fail') &&
        event.taskId === section.summary.id))
  );
}

function* batchActivity(
  walk: TranscriptWalk,
  reads: TranscriptWalkReads,
  event: RunnerActivityEvent,
  globalIndex: number,
): Generator<TranscriptWalkStep> {
  const batch = walk.activityBatch;
  if (batch !== null && batch.callId === event.callId) {
    batch.events.push(event);
    batch.lastEvent = event;
    return;
  }
  yield* flush(walk, reads);
  walk.lastRowEvent = null;
  walk.activityBatch = {
    callId: event.callId,
    firstIndex: globalIndex,
    events: [event],
    lastEvent: event,
  };
}

/** The seat switch and the correction of the open fold wait for it to close; its events join it. */
function joinsOpenRecovery(walk: TranscriptWalk, event: EngineEvent, globalIndex: number): boolean {
  const { recovery } = walk;
  if (recovery === null) return false;
  if (
    event.type === 'seat_switched' &&
    recovery.resolved === undefined &&
    recovery.seatSwitch === undefined &&
    recovery.selected?.action === 'switch-seat' &&
    recovery.selected.seat === event.seat &&
    recovery.selected.reason === event.cause &&
    recovery.selected.phase === event.phase
  ) {
    recovery.seatSwitch = event;
    walk.afterRecovery.push({ kind: 'event', event, globalIndex, ...walk.settledContext });
    return true;
  }
  if (
    event.type === 'user_message' &&
    recovery.selected !== undefined &&
    recovery.resolved === undefined
  ) {
    walk.afterRecovery.push({ kind: 'event', event, globalIndex, ...walk.settledContext });
    return true;
  }
  return joinsRecovery(recovery, event);
}

/**
 * A prompt that restates the halt above it waits for the fold its choice opens; any other prompt, a
 * choice or an outcome opens a fold.
 */
function opensRecovery(walk: TranscriptWalk, event: EngineEvent, globalIndex: number): boolean {
  if (event.type === 'recovery_prompted' && restatesHalt(walk.lastRowEvent, event)) {
    walk.restatedPrompt = event;
    return true;
  }
  if (
    event.type !== 'recovery_prompted' &&
    event.type !== 'recovery_action_selected' &&
    event.type !== 'recovery_resolved'
  )
    return false;
  const recovery: RecoveryFold = { firstIndex: globalIndex, issueId: event.issueId };
  if (walk.restatedPrompt?.issueId === event.issueId) {
    recovery.prompted = walk.restatedPrompt;
    recovery.haltAlreadyShown = true;
  }
  walk.restatedPrompt = null;
  walk.recovery = recovery;
  joinsRecovery(recovery, event);
  walk.lastRowEvent = event;
  return true;
}
