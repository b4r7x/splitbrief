import {
  isSettledSection,
  type ReviewStage,
  type Section,
} from '../../../core/sections/event-sections.js';
import { stripRecoveryResetClause } from '../../../core/recovery/reset-clock.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { CREW_SEAT_LABELS, type CrewSeatId } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { formatSeatChangeNotice } from '../../../core/state/seats.js';
import { formatRecordedSeatChangeIdentities } from '../display/recorded-seat-identity.js';
import { WORKSPACE_KEPT_CODE } from '../../../core/sessions/workspace-notice.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from './event-rows/visibility.js';

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

export interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
  lastEvent: RunnerActivityEvent;
}

/** The halt, the action a person chose, the reset it made and the outcome it reached. */
type RecoveryFoldEvents = {
  firstIndex: number;
  issueId: string;
  prompted?: EngineEventOf<'recovery_prompted'>;
  selected?: EngineEventOf<'recovery_action_selected'>;
  reset?: EngineEventOf<'task_reset'>;
  resolved?: EngineEventOf<'recovery_resolved'>;
  seatSwitch?: EngineEventOf<'seat_switched'>;
  haltAlreadyShown?: true;
};

export type RecoveryFold = RecoveryFoldEvents &
  (
    | { automaticSwitch?: undefined; diagnostics?: undefined }
    | {
        automaticSwitch: EngineEventOf<'seat_switched'>;
        prompted: EngineEventOf<'recovery_prompted'>;
        diagnostics: readonly string[];
      }
  );

export type SettledTranscriptSection = Extract<
  Section<EngineEvent>,
  { type: 'completed-task' | 'settled-stage' }
>;

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

export type TranscriptWalkStep =
  | { kind: 'settled'; section: SettledTranscriptSection }
  | { kind: 'review-heading'; startIndex: number; review: ReviewStage; items: EngineEvent[] }
  | { kind: 'settled-end'; section: SettledTranscriptSection }
  | ((
      | { kind: 'activity-batch'; batch: RunnerActivityBatch; callEnded: boolean }
      | { kind: 'recovery'; recovery: RecoveryFold }
      | {
          kind: 'event';
          event: EngineEvent;
          globalIndex: number;
          causeInRecovery?: boolean;
          historicalTaskHeader?: true;
        }
    ) & { settledSection?: SettledTranscriptSection });

// The single traversal both the projection and the clickable-action builders consume, so the
// consecutive-`runner_call_activity` batching stays byte-identical between rendered rows and their
// click targets. A batch closes on a call-id change, a settled section boundary, any non-rowless
// event (yielded before that event), or the end of the transcript; row-less events never split it.
// A recovery folds the same way: its prompt or its selection opens the fold, and the selection,
// the reset and the outcome of that issue join it until another row-producing event closes it.
// Its seat switch waits for the fold to close, then follows the Recovery row it belongs to.
// A prompt the error row before it already states opens nothing. A brief its recovery restarted
// keeps the one header it opened with: the Recovery row already says it went back to pending.
// A seat switch folds one matching reconciliation notice before the next run starts or resumes.
// A workspace kept for Continue drops out once the run continues or a close (End run, Discard or
// Apply) lets it go; a later stop that keeps it again shows its own notice. A batch of a call that
// has ended says so, so no batch of a stopped or finished call carries the live mark. A review opens
// with its heading while it runs and keeps it once it settles, so no row appears above its rows.
export function* walkTranscript(
  sections: readonly Section<EngineEvent>[],
): Generator<TranscriptWalkStep> {
  const automatic = automaticRecoveryFolds(sections);
  let workspaceNotice: EngineEventOf<'warning'> | undefined;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'warning' && event.code === WORKSPACE_KEPT_CODE) workspaceNotice = event;
      if (event.type === 'workflow_resumed' || event.type === 'workspace_closed')
        workspaceNotice = undefined;
    }
  }
  const endedAttempts = endedImplementerAttempts(sections);
  const endedActivity = endedCallActivity(sections);
  let activityBatch: RunnerActivityBatch | null = null;
  let recovery: RecoveryFold | null = null;
  let recoverySwitch: Extract<TranscriptWalkStep, { kind: 'event' }> | null = null;
  let lastRowEvent: EngineEvent | null = null;
  let openHeader: EngineEventOf<'task_started'> | null = null;
  let restatedPrompt: EngineEventOf<'recovery_prompted'> | null = null;
  const seatSwitches = new Map<CrewSeatId, EngineEventOf<'seat_switched'>>();
  let settledContext: { settledSection?: SettledTranscriptSection } = {};

  function* flush(): Generator<TranscriptWalkStep> {
    if (activityBatch !== null)
      yield {
        kind: 'activity-batch',
        batch: activityBatch,
        callEnded: endedActivity.has(activityBatch.lastEvent),
        ...settledContext,
      };
    if (recovery !== null) yield { kind: 'recovery', recovery, ...settledContext };
    if (recoverySwitch !== null) yield recoverySwitch;
    activityBatch = null;
    recovery = null;
    recoverySwitch = null;
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
      if (automatic.hidden.has(event) || endedAttempts.has(event)) continue;
      if (event.type === 'workflow_started' || event.type === 'workflow_resumed')
        seatSwitches.clear();
      if (event.type === 'seat_switched') seatSwitches.set(event.seat, event);
      if (event.type === 'warning') {
        if (event.code === WORKSPACE_KEPT_CODE && event !== workspaceNotice) continue;
        const switched = [...seatSwitches.values()].find((switchEvent) =>
          restatesSeatSwitch(event, switchEvent),
        );
        if (switched !== undefined) {
          seatSwitches.delete(switched.seat);
          continue;
        }
      }
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
        recoverySwitch === null &&
        recovery.selected?.action === 'switch-seat' &&
        recovery.selected.seat === event.seat &&
        recovery.selected.reason === event.cause &&
        recovery.selected.phase === event.phase
      ) {
        recovery.seatSwitch = event;
        recoverySwitch = { kind: 'event', event, globalIndex, ...settledContext };
        continue;
      }
      if (recovery !== null && joinsRecovery(recovery, event)) continue;
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
  yield* flush();
}

/**
 * The `working on <file>…` rows whose attempt has ended. The row says a BUILD call is running; once
 * the attempt is done, failed, reset, cut by a stop, or closed by a call error — the interruption a
 * process that went away leaves — the rows after it say what happened, and the row goes.
 */
function endedImplementerAttempts(sections: readonly Section<EngineEvent>[]): Set<EngineEvent> {
  const ended = new Set<EngineEvent>();
  const open = new Map<string, EngineEventOf<'implementer_generate_running'>>();
  const end = (taskId: string | undefined): void => {
    for (const [openTaskId, running] of open) {
      if (taskId !== undefined && taskId !== openTaskId) continue;
      ended.add(running);
      open.delete(openTaskId);
    }
  };
  for (const section of sections) {
    for (const event of section.items) {
      switch (event.type) {
        case 'implementer_generate_running':
          end(event.taskId);
          open.set(event.taskId, event);
          break;
        case 'implementer_generate_done':
        case 'implementer_generate_failed':
        case 'task_reset':
          end(event.taskId);
          break;
        case 'turn_interrupted':
        case 'workflow_cancelled':
        case 'workflow_resumed':
          end(undefined);
          break;
        case 'runner_call_activity':
          if (event.role === 'implementer' && isCallError(event)) end(event.taskId);
          break;
      }
    }
  }
  return ended;
}

/**
 * The activity of the calls that have ended. A call ends at its completion or at its error, which
 * the log keeps as the call's terminal activity, and a stop, a cancel or a continue ends every call
 * still in flight.
 */
function endedCallActivity(sections: readonly Section<EngineEvent>[]): Set<EngineEvent> {
  const ended = new Set<EngineEvent>();
  const open = new Map<string, RunnerActivityEvent[]>();
  const end = (callId: string): void => {
    for (const activity of open.get(callId) ?? []) ended.add(activity);
    open.delete(callId);
  };
  for (const section of sections) {
    for (const event of section.items) {
      switch (event.type) {
        case 'runner_call_activity': {
          const activity = open.get(event.callId);
          if (activity === undefined) open.set(event.callId, [event]);
          else activity.push(event);
          if (isCallError(event)) end(event.callId);
          break;
        }
        case 'runner_call_completed':
          end(event.callId);
          break;
        case 'turn_interrupted':
        case 'workflow_cancelled':
        case 'workflow_resumed':
          for (const callId of [...open.keys()]) end(callId);
          break;
      }
    }
  }
  return ended;
}

/** A call's error is its terminal activity; an error-severity warning leaves the call running. */
function isCallError(activity: RunnerActivityEvent): boolean {
  return activity.kind === 'error' && activity.stage !== 'warning';
}

function restatesSeatSwitch(
  warning: EngineEventOf<'warning'>,
  switched: EngineEventOf<'seat_switched'>,
): boolean {
  const prefix = `${CREW_SEAT_LABELS[switched.seat]} seat changed `;
  if (!warning.message.startsWith(prefix)) return false;
  const identities = formatRecordedSeatChangeIdentities(
    switched.from,
    switched.to,
    CREW_SEAT_ROLES[switched.seat],
  );
  const notice = formatSeatChangeNotice({ seat: switched.seat, before: '', after: identities.to });
  return warning.message.endsWith(notice.slice(prefix.length));
}

type FailedCall = {
  event: EngineEventOf<'runner_call_activity' | 'runner_call_error' | 'runner_call_warning'>;
  events: EngineEvent[];
  words: Set<string>;
};

type RecoveryChain = {
  recovery: RecoveryFold & { prompted: EngineEventOf<'recovery_prompted'> };
  events: EngineEvent[];
  call: FailedCall | undefined;
  halt: EngineEventOf<'error'> | undefined;
  failure: EngineEventOf<'implementer_generate_failed'> | undefined;
  automaticSwitch?: EngineEventOf<'seat_switched'>;
};

function automaticRecoveryFolds(sections: readonly Section<EngineEvent>[]) {
  const hidden = new Set<EngineEvent>();
  const switches = new Set<EngineEvent>();
  const recoveries = new Map<EngineEvent, RecoveryFold>();
  const calls = new Map<string, FailedCall>();
  const latestCalls = new Map<string | undefined, FailedCall>();
  const issues = new Map<string, RecoveryChain>();
  let selected: RecoveryChain | undefined;
  let previous: EngineEvent | undefined;
  let failure: EngineEventOf<'implementer_generate_failed'> | undefined;

  for (const section of sections) {
    for (const [index, event] of section.items.entries()) {
      if (
        event.type === 'runner_call_error' ||
        event.type === 'runner_call_warning' ||
        (event.type === 'runner_call_activity' &&
          (event.kind === 'warning' || event.kind === 'error'))
      ) {
        let call = calls.get(event.callId);
        if (call === undefined) {
          call = { event, events: [], words: new Set() };
          calls.set(event.callId, call);
        }
        call.events.push(event);
        const words =
          event.type === 'runner_call_activity'
            ? event.diagnosticPartial
            : event.type === 'runner_call_error'
              ? event.error.message
              : event.warning.message;
        if (words !== undefined && words !== '') call.words.add(words);
        latestCalls.set(event.taskId, call);
      } else if (event.type === 'implementer_generate_failed') {
        failure = event;
      } else if (event.type === 'recovery_prompted') {
        const existing = issues.get(event.issueId);
        if (existing !== undefined && existing.recovery.selected === undefined) {
          existing.events.push(event);
        } else {
          issues.set(event.issueId, {
            recovery: {
              firstIndex: section.startIndex + index,
              issueId: event.issueId,
              prompted: event,
            },
            events: [event],
            call: latestCalls.get(event.taskId),
            halt:
              previous?.type === 'error' && previous.phase === event.phase ? previous : undefined,
            failure,
          });
        }
      } else if (event.type === 'recovery_action_selected') {
        selected = issues.get(event.issueId);
        if (selected !== undefined) {
          selected.recovery.selected = event;
          selected.events.push(event);
        }
      } else if (event.type === 'seat_switched') {
        if (
          event.auto &&
          selected?.recovery.selected?.action === 'switch-seat' &&
          selected.recovery.selected.seat === event.seat &&
          selected.recovery.prompted.reason === event.cause &&
          selected.recovery.prompted.phase === event.phase
        )
          selected.automaticSwitch = event;
      } else if (event.type === 'recovery_resolved') {
        const chain = issues.get(event.issueId);
        const switched = chain?.automaticSwitch;
        if (
          chain !== undefined &&
          switched !== undefined &&
          event.action === 'switch-seat' &&
          event.seat === switched.seat &&
          event.reason === chain.recovery.prompted.reason &&
          (event.outcome === 'continued' || event.outcome === 'retry-current-task')
        ) {
          const { recovery, halt } = chain;
          recovery.resolved = event;
          const call = chain.call;
          const linkedCall =
            call !== undefined &&
            call.event.taskId === recovery.prompted.taskId &&
            call.event.phase === recovery.prompted.phase &&
            call.event.runnerName === switched.from.tool &&
            call.event.model === switched.from.model;
          const words = new Set<string>();
          if (linkedCall) {
            for (const diagnostic of call.events) hidden.add(diagnostic);
            for (const word of call.words) words.add(word);
          }
          if (
            switched.seat === 'build' &&
            chain.failure !== undefined &&
            chain.failure.taskId === recovery.prompted.taskId &&
            chain.failure.phase === recovery.prompted.phase &&
            chain.failure.model === switched.from.model
          ) {
            hidden.add(chain.failure);
            if (chain.failure.error !== undefined) words.add(chain.failure.error);
          }
          if (
            halt !== undefined &&
            (restatesHalt(halt, recovery.prompted) ||
              [...words].some((word) => halt.message.includes(word)))
          )
            hidden.add(halt);
          for (const folded of chain.events) hidden.add(folded);
          hidden.add(event);
          recoveries.set(recovery.prompted, {
            ...recovery,
            automaticSwitch: switched,
            diagnostics: [...words],
          });
          switches.add(switched);
        }
        if (selected === chain) selected = undefined;
      } else if (event.type === 'recovery_action_failed') {
        if (selected?.recovery.issueId === event.issueId) selected = undefined;
      } else if (event.type === 'task_started') {
        failure = undefined;
      }
      if (!isTranscriptRowlessEvent(event)) previous = event;
    }
  }
  return { hidden, switches, recoveries };
}

// A restart the recovery made on the same worker restates the header; one on another seat or
// profile is news the reader needs.
function sameHeader(
  open: EngineEventOf<'task_started'>,
  next: EngineEventOf<'task_started'>,
): boolean {
  return (
    open.taskId === next.taskId &&
    open.tool === next.tool &&
    open.model === next.model &&
    open.implementerProfile === next.implementerProfile
  );
}

function joinsRecovery(recovery: RecoveryFold, event: EngineEvent): boolean {
  if (recovery.resolved !== undefined) return false;
  switch (event.type) {
    // A resumed run prompts the same issue again; it is still the one halt.
    case 'recovery_prompted':
      if (event.issueId !== recovery.issueId || recovery.selected !== undefined) return false;
      recovery.prompted = event;
      return true;
    case 'recovery_action_selected':
      if (event.issueId !== recovery.issueId || recovery.selected !== undefined) return false;
      recovery.selected = event;
      return true;
    case 'task_reset':
      if (recovery.selected === undefined || recovery.reset !== undefined) return false;
      recovery.reset = event;
      return true;
    case 'recovery_resolved':
      if (event.issueId !== recovery.issueId) return false;
      recovery.resolved = event;
      return true;
    default:
      return false;
  }
}

// The error row already names the halt; the prompt's card would say it a second time. A headline
// that carries the halt's evidence joins it with ` · ` where the error sentence uses ` — `.
function restatesHalt(
  previous: EngineEvent | null,
  prompted: EngineEventOf<'recovery_prompted'>,
): boolean {
  return (
    previous?.type === 'error' &&
    previous.message
      .replace(' — ', SOFT_SEP)
      .startsWith(stripRecoveryResetClause(prompted.headline))
  );
}
