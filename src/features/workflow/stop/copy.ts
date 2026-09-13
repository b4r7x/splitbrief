import { SOFT_SEP } from '../../../components/separators.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../stores/workflow/stop.js';
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
  readonly sheetOpen: boolean;
  readonly questionPending: boolean;
}

export interface StopByline {
  readonly lead: string;
  readonly hint: string;
}

/** The run names its own brief where it has one, and says "the run" rather than nothing. */
function subject(input: StopBylineInput): string {
  return input.parked?.taskId ?? input.currentTaskId ?? 'the run';
}

export function stopByline(input: StopBylineInput): StopByline | null {
  const taskId = subject(input);

  if (input.intent === 'none') {
    // The sheet is a question, not a stop: the byline behind it says the run is untouched.
    if (!input.sheetOpen) return null;
    return { lead: `Building ${taskId} of ${input.total}`, hint: 'Still running' };
  }

  if (input.phase === 'parked') {
    if (input.parked?.kind === 'boundary') {
      return {
        lead: `Paused after ${taskId}${SOFT_SEP}${input.passed} of ${input.total} briefs complete`,
        hint: `/resume to start ${input.nextTaskId ?? 'the next brief'}${SOFT_SEP}/end${SOFT_SEP}esc home`,
      };
    }
    return {
      lead: `Paused at ${taskId}${SOFT_SEP}Partial changes kept`,
      hint: `/resume${SOFT_SEP}type instructions, enter to send and resume${SOFT_SEP}/end${SOFT_SEP}esc home`,
    };
  }

  if (input.phase === 'ended') {
    return {
      lead: `Cancelled by you at ${taskId}${SOFT_SEP}Changes kept`,
      hint: `esc home${SOFT_SEP}/quit`,
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
  return {
    lead: `${lead}${SOFT_SEP}Waiting for processes to exit${SOFT_SEP}elapsed ${formatStageElapsed(input.elapsedMs)}`,
    hint: 'No new work will start',
  };
}
