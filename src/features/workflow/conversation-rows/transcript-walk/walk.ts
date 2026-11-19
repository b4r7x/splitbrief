import { isInfrastructurePhaseEvent } from '../../../../core/phases/of-event.js';
import { type Section, isSettledSection } from '../../../../core/sections/types.js';
import type { EngineEventOf, EngineEvent } from '../../../../engine/events/types.js';
import {
  endedImplementerAttempts,
  endedCallActivity,
  retriedImplementerAttempts,
  reissuedPlannerCallDiagnostics,
  heldConsultAnswers,
} from './ended-calls.js';
import { flush, walkEvent } from './event.js';
import { automaticRecoveryFolds, sameHeader } from './recovery-folds.js';
import { answeredResumes, carriedOnSeatChanges, keptWorkspaceNotice } from './resumes.js';
import type {
  SettledTranscriptSection,
  TranscriptWalk,
  TranscriptWalkReads,
  TranscriptWalkStep,
  WalkSection,
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
  const transcript = sectionsWithoutReplayMarkers(sections);
  const reads = walkReads(sections, transcript);
  const walk: TranscriptWalk = {
    activityBatch: null,
    recovery: null,
    afterRecovery: [],
    checkRun: [],
    lastRowEvent: null,
    openHeader: null,
    restatedPrompt: null,
    settledContext: {},
  };
  for (const section of transcript) {
    const scope = walkSection(section);
    yield* enterSection(walk, reads, scope);
    for (const [index, event] of section.items.entries())
      yield* walkEvent(walk, reads, scope, event, section.startIndex + index);
    yield* leaveSection(walk, reads, section);
  }
  yield* flush(walk, reads, true);
}

export function sectionsWithoutReplayMarkers(
  sections: readonly Section<EngineEvent>[],
): Section<EngineEvent>[] {
  let markers = 0;
  return sections.map((section) => {
    const startIndex = section.startIndex - markers;
    const items = section.items.some(isInfrastructurePhaseEvent)
      ? section.items.filter((event) => !isInfrastructurePhaseEvent(event))
      : section.items;
    markers += section.items.length - items.length;
    return startIndex === section.startIndex && items === section.items
      ? section
      : { ...section, startIndex, items };
  });
}

function walkReads(
  sections: readonly Section<EngineEvent>[],
  transcript: readonly Section<EngineEvent>[],
): TranscriptWalkReads {
  const automatic = automaticRecoveryFolds(transcript);
  return {
    recoveries: automatic.recoveries,
    switches: automatic.switches,
    hidden: new Set([
      ...automatic.hidden,
      // replay_complete can mark an implementer attempt cut short by a process exit.
      ...endedImplementerAttempts(sections),
      ...carriedOnSeatChanges(sections),
      ...answeredResumes(sections),
      ...retriedImplementerAttempts(sections),
      ...reissuedPlannerCallDiagnostics(sections),
      ...heldConsultAnswers(sections),
    ]),
    workspaceNotice: keptWorkspaceNotice(sections),
    endedActivity: endedCallActivity(sections),
  };
}

function walkSection(section: Section<EngineEvent>): WalkSection {
  const latestHeaders = new Map<string, EngineEventOf<'task_started'>>();
  for (const event of section.items) {
    if (event.type !== 'task_started') continue;
    const header = latestHeaders.get(event.taskId);
    if (header === undefined || !sameHeader(header, event)) latestHeaders.set(event.taskId, event);
  }
  const review =
    section.type === 'active-review'
      ? section.review
      : section.type === 'settled-stage' && section.summary.stage === 'review'
        ? section.summary
        : undefined;
  const started = isSettledSection(section) ? settledTaskStartedEvent(section) : undefined;
  return { section, review, started, latestHeaders };
}

function* enterSection(
  walk: TranscriptWalk,
  reads: TranscriptWalkReads,
  { section, review, started }: WalkSection,
): Generator<TranscriptWalkStep> {
  if (isSettledSection(section) || review !== undefined) {
    yield* flush(walk, reads);
    walk.lastRowEvent = null;
  }
  walk.settledContext = isSettledSection(section) ? { settledSection: section } : {};
  if (isSettledSection(section)) walk.openHeader = started ?? null;
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
}

function* leaveSection(
  walk: TranscriptWalk,
  reads: TranscriptWalkReads,
  section: Section<EngineEvent>,
): Generator<TranscriptWalkStep> {
  if (!isSettledSection(section)) return;
  yield* flush(walk, reads);
  if (section.type === 'settled-stage' && section.summary.stage === 'review')
    yield { kind: 'settled-end', section };
  walk.lastRowEvent = null;
  walk.openHeader = null;
}
