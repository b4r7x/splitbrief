import type { StepCut, StepRef } from '../../../core/schemas/run-step.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { taskId } from '../../../core/schemas/task.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import type { RunningSuiteStage } from '../../../stores/workflow/operations/state.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../stores/workflow/stop.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import { suiteStatusText } from '../display/phase-verb.js';

const PARKED_HINT = `⏎ resume${SOFT_SEP}/stop options${SOFT_SEP}esc back to sessions${SOFT_SEP}ctrl+c quit`;

export interface StopBylineInput {
  readonly intent: StopIntent;
  readonly phase: StopPhase;
  readonly workflowPhase: Phase;
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
  /** The command run before a review now, which a pause armed between briefs waits on. */
  readonly suite: {
    readonly id?: string | undefined;
    readonly moment: RunningSuiteStage['moment'];
    readonly scenario?: string | undefined;
    readonly command: string;
    readonly elapsedMs: number;
  } | null;
  readonly error?: string | undefined;
  /** The run's record once the stop has settled it at rest: where it stopped, and what it kept. */
  readonly record?: RunRecord | null | undefined;
}

export interface StopByline {
  readonly lead: string;
  /** The lead's clock, kept whole when the byline cuts the lead to its width. */
  readonly clock?: string | undefined;
  readonly hint: string;
}

/**
 * A step in the words the rest of the screen uses for it: a brief by id, and every planner call or
 * gate as the plan, the one stage the rail shows for them.
 */
export function stepWord(step: StepRef): string {
  switch (step.kind) {
    case 'planner':
    case 'gate':
      return 'the plan';
    case 'brief':
      return step.taskId;
    default:
      return 'the review';
  }
}

/**
 * Where a stop left the run, in the words the transcript row and every byline share: before the
 * brief a stop between briefs holds back, else at the step it stopped on.
 */
export function stopPoint(step: StepRef, at: StepCut | undefined): string {
  if (at === 'boundary') {
    if (step.kind === 'brief') return `before ${step.taskId}`;
    if (step.kind === 'review') return 'before the review';
  }
  return `at ${stepWord(step)}`;
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
    if (brief === null) return 'Stopped';
    const cut: StepCut | undefined =
      input.parked?.kind === 'boundary'
        ? 'boundary'
        : input.parked?.kind === 'mid-brief'
          ? 'mid-step'
          : undefined;
    const lead = `Stopped ${stopPoint({ kind: 'brief', taskId: taskId(brief), attempt: 0 }, cut)}`;
    return cut === 'mid-step' ? `${lead}${SOFT_SEP}Partial changes kept` : lead;
  }
  const at = status.stop.on.kind === 'paused' ? status.stop.on.at : undefined;
  const lead = `Stopped ${stopPoint(status.resumeAt, at)}`;
  const cutBrief = status.resumeAt.kind === 'brief' && at === 'mid-step';
  return cutBrief ? `${lead}${SOFT_SEP}Partial changes kept` : lead;
}

export function stopByline(input: StopBylineInput): StopByline | null {
  const name = subject(input);

  if (input.intent === 'none') return null;

  if (input.phase === 'failed')
    return {
      lead: `Stop failed${SOFT_SEP}${input.error ?? 'Cleanup did not finish'}`,
      hint: '/stop to retry',
    };

  if (input.phase === 'parked') {
    if (input.parked?.kind === 'boundary') {
      const next: StepRef =
        input.nextTaskId === null
          ? { kind: 'review', cycle: 0 }
          : { kind: 'brief', taskId: taskId(input.nextTaskId), attempt: 0 };
      return {
        lead: `Stopped ${stopPoint(next, 'boundary')}${SOFT_SEP}${input.passed} of ${input.total} briefs complete`,
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
      return { lead: `Answer needed to finish ${name}`, hint: 'Pause requested' };
    }
    const hint = 'Pause requested; no next brief will start';
    if (input.suite === null) return { lead: `Finishing ${name}`, hint };
    return {
      lead: suiteStatusText({ phase: input.workflowPhase, suite: input.suite }),
      clock: formatElapsedClock(input.suite.elapsedMs),
      hint,
    };
  }

  const lead = input.intent === 'end-run' ? 'Ending run' : `Stopping ${name}`;
  if (input.phase === 'forcing') {
    return { lead: `${lead}${SOFT_SEP}Forcing remaining processes to exit`, hint: '' };
  }
  const progress =
    input.phase === 'terminating'
      ? 'Waiting for processes to exit'
      : 'Finishing cleanup and saving';
  return {
    lead: `${lead}${SOFT_SEP}${progress}${SOFT_SEP}${formatElapsedClock(input.elapsedMs)}`,
    hint: `esc back after stop${SOFT_SEP}ctrl+c quit after stop`,
  };
}
