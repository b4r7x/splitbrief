import type { Summary } from '../../../core/schemas/summary.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../stores/workflow/stop.js';
import { stepWord } from '../closed/byline.js';
import { filesView, stoppedAtForCurrentPlan } from '../closed/projections.js';
import { formatStageElapsed } from '../display/live-activity.js';

export interface StopBylineInput {
  readonly intent: StopIntent;
  readonly phase: StopPhase;
  readonly parked: { readonly kind: StopParkKind; readonly taskId: string | null } | null;
  readonly currentTaskId: string | null;
  readonly nextTaskId: string | null;
  readonly passed: number;
  readonly total: number;
  /** Since the stop was asked for, so the wait is reported rather than guessed at. */
  readonly elapsedMs: number;
  readonly questionPending: boolean;
  readonly error?: string | undefined;
  /** The run's record once the stop has settled it at rest: where it stopped, and what it kept. */
  readonly record?: RunRecord | null | undefined;
}

export interface StopByline {
  readonly lead: string;
  readonly hint: string;
}

/** The run names its own brief where it has one, and says "the run" rather than nothing. */
function subject(input: StopBylineInput): string {
  return input.parked?.taskId ?? input.currentTaskId ?? 'the run';
}

/**
 * Where a stop parked the run, in the words its record uses. Only a brief the stop cut mid-step has
 * partial work to keep: a planner step, a gate or a brief not yet started changed nothing.
 */
function pausedLead(input: StopBylineInput): string {
  const status = input.record?.status;
  if (status?.kind !== 'open') {
    const brief = input.parked?.taskId ?? input.currentTaskId;
    return brief === null ? 'Paused' : `Paused at ${brief}${SOFT_SEP}Partial changes kept`;
  }
  const lead = `Paused at ${stepWord(status.resumeAt)}`;
  const cutBrief =
    status.resumeAt.kind === 'brief' &&
    status.stop.kind === 'paused' &&
    status.stop.at === 'mid-step';
  return cutBrief ? `${lead}${SOFT_SEP}Partial changes kept` : lead;
}

/**
 * How an ended run stands, from the record it closed with: the step it stopped at when the record
 * can say, and kept changes only when its summary booked some.
 */
function endedLead(input: StopBylineInput): string {
  const { record } = input;
  if (record?.status.kind !== 'closed') {
    const brief = input.parked?.taskId ?? input.currentTaskId;
    return brief === null
      ? 'Cancelled by you'
      : `Cancelled by you at ${brief}${SOFT_SEP}Changes kept`;
  }
  const summary =
    record.summary === null
      ? null
      : {
          ...record.summary,
          stoppedAt: stoppedAtForCurrentPlan({
            summary: record.summary,
            ledger: record.ledger,
            state: record.hydration.kind === 'loaded' ? record.hydration.state : null,
          }),
        };
  const at = endedAt(record, summary?.stoppedAt);
  const lead = at === null ? 'Cancelled by you' : `Cancelled by you at ${at}`;
  const kept = summary === null ? null : keptChanges(summary);
  return kept === null ? lead : `${lead}${SOFT_SEP}${kept}`;
}

/**
 * A closed record keeps no step. Its summary names the brief it stopped in, and its phase names a
 * gate or the review; which planner call was running needs artifacts the record does not carry.
 */
function endedAt(record: RunRecord, stoppedAt: Summary['stoppedAt']): string | null {
  const stopped = stoppedAt?.taskId;
  if (stopped !== undefined) return stopped;
  if (record.hydration.kind !== 'loaded') return null;
  const step = resumeStep(record.hydration.state);
  return step.kind === 'planner' ? null : stepWord(step);
}

/** The disposition the closed transcript block states, claimed only when there is one to keep. */
function keptChanges(summary: Summary): string | null {
  const files = filesView(summary);
  if (files.partial.size > 0) return 'Partial changes kept';
  if (files.changed !== null && files.changed.length > 0) return 'Changes kept';
  return null;
}

export function stopByline(input: StopBylineInput): StopByline | null {
  const taskId = subject(input);

  if (input.intent === 'none') return null;

  if (input.phase === 'failed')
    return {
      lead: `Stop failed${SOFT_SEP}${input.error ?? 'Cleanup did not finish'}`,
      hint: '/stop to retry',
    };

  if (input.phase === 'parked') {
    if (input.parked?.kind === 'boundary') {
      return {
        lead: `Paused after ${taskId}${SOFT_SEP}${input.passed} of ${input.total} briefs complete`,
        hint: `/resume${SOFT_SEP}/stop options${SOFT_SEP}esc back to sessions${SOFT_SEP}ctrl+c quit`,
      };
    }
    return {
      lead: pausedLead(input),
      hint: `/resume${SOFT_SEP}/stop options${SOFT_SEP}esc back to sessions${SOFT_SEP}ctrl+c quit`,
    };
  }

  if (input.phase === 'ended') {
    return {
      lead: endedLead(input),
      hint: `esc back to sessions${SOFT_SEP}ctrl+c quit`,
    };
  }

  if (input.intent === 'quit') {
    return { lead: 'Quitting', hint: 'Stopping processes and saving session' };
  }

  // A boundary pause kills nothing: the brief runs to its end, so the byline reports the finish
  // rather than a termination that is not happening.
  if (input.intent === 'pause-after-brief') {
    if (input.questionPending) {
      return { lead: `Answer needed to finish ${taskId}`, hint: 'Pause requested' };
    }
    return { lead: `Finishing ${taskId}`, hint: 'Pause requested; no next brief will start' };
  }

  const lead = input.intent === 'end-run' ? 'Ending run' : `Stopping ${taskId}`;
  if (input.phase === 'forcing') {
    return { lead: `${lead}${SOFT_SEP}Forcing remaining processes to exit`, hint: '' };
  }
  const progress =
    input.phase === 'terminating'
      ? 'Waiting for processes to exit'
      : 'Finishing cleanup and saving';
  return {
    lead: `${lead}${SOFT_SEP}${progress}${SOFT_SEP}${formatStageElapsed(input.elapsedMs)}`,
    hint: `esc back after stop${SOFT_SEP}ctrl+c quit after stop`,
  };
}
