import { SOFT_SEP } from '../../../core/separators.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import type { RunningSuiteStage } from '../../../stores/workflow/operations/state.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../stores/workflow/stop.js';
import { stepWord } from '../closed/byline.js';
import { formatStageElapsed } from '../display/live-activity.js';
import { suiteStageText } from '../display/phase-verb.js';

const PARKED_HINT = `⏎ resume${SOFT_SEP}/stop options${SOFT_SEP}esc back to sessions${SOFT_SEP}ctrl+c quit`;

export interface StopBylineInput {
  readonly intent: StopIntent;
  readonly phase: StopPhase;
  readonly parked: { readonly kind: StopParkKind; readonly taskId: string | null } | null;
  readonly currentTaskId: string | null;
  readonly nextTaskId: string | null;
  /** The brief the run last finished, named when a pause outlives the brief it was armed on. */
  readonly finishedTaskId?: string | null;
  readonly passed: number;
  readonly total: number;
  /** Since the stop was asked for, so the wait is reported rather than guessed at. */
  readonly elapsedMs: number;
  readonly questionPending: boolean;
  /** The full-suite stage running now, which a pause armed between briefs waits on. */
  readonly suite: {
    readonly moment: RunningSuiteStage['moment'];
    readonly command: string;
    readonly elapsedMs: number;
  } | null;
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
  return input.parked?.taskId ?? input.currentTaskId ?? input.finishedTaskId ?? 'the run';
}

/**
 * Where a stop parked the run, in the words its record uses. Only a brief the stop cut mid-step has
 * partial work to keep: a planner step, a gate or a brief not yet started changed nothing.
 */
function stoppedLead(input: StopBylineInput): string {
  const status = input.record?.status;
  if (status?.kind !== 'open') {
    const brief = input.parked?.taskId ?? input.currentTaskId;
    return brief === null ? 'Stopped' : `Stopped at ${brief}${SOFT_SEP}Partial changes kept`;
  }
  const lead = `Stopped at ${stepWord(status.resumeAt)}`;
  const cutBrief =
    status.resumeAt.kind === 'brief' &&
    status.stop.on.kind === 'paused' &&
    status.stop.on.at === 'mid-step';
  return cutBrief ? `${lead}${SOFT_SEP}Partial changes kept` : lead;
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
        hint: PARKED_HINT,
      };
    }
    return {
      lead: stoppedLead(input),
      hint: PARKED_HINT,
    };
  }

  // End run closed the run: the closed run's own byline speaks for it.
  if (input.phase === 'ended') return null;

  if (input.intent === 'quit') {
    return { lead: 'Quitting', hint: 'Stopping processes and saving session' };
  }

  // A boundary pause kills nothing: the brief runs to its end, so the byline reports the finish
  // rather than a termination that is not happening.
  if (input.intent === 'pause-after-brief') {
    if (input.questionPending) {
      return { lead: `Answer needed to finish ${taskId}`, hint: 'Pause requested' };
    }
    const lead =
      input.suite === null
        ? `Finishing ${taskId}`
        : `${suiteStageText(input.suite)} ${formatStageElapsed(input.suite.elapsedMs)}`;
    return { lead, hint: 'Pause requested; no next brief will start' };
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
