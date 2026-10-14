import type { StepCut, StepRef } from '../../../core/schemas/run-step.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { taskId } from '../../../core/schemas/task.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import type { RunningSuiteStage } from '../../../stores/workflow/operations/state.js';
import type { StopIntent, StopParkKind, StopPhase } from '../../../stores/workflow/stop.js';
import { formatElapsedClock } from '../../../utils/format-time.js';
import { suiteStatusParts } from '../display/phase-verb.js';
import { stateTone, type StateTone } from '../../../core/theme/state-tone.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { separatedSpans } from '../conversation-rows/row-format/text.js';

const PARKED_HINT = `⏎ resume${SOFT_SEP}/stop options${SOFT_SEP}esc back to sessions${SOFT_SEP}ctrl+c quit`;

export interface StopBylineInput {
  readonly intent: StopIntent;
  readonly phase: StopPhase;
  readonly workflowPhase: Phase;
  readonly parked: {
    readonly kind: StopParkKind;
    readonly taskId: string | null;
    /** The declared files the cut brief had changed when the stop parked it. */
    readonly kept: readonly string[];
  } | null;
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
  readonly tone: StateTone;
  readonly parts: readonly ConversationRowSegment[];
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
 * Where a stop parked the run, in the words its record uses. Only a brief the stop cut mid-step can
 * keep partial work, and only when the stop found files it had changed: a planner step, a gate, a
 * brief not yet started or a brief cut before its first write kept nothing.
 */
function stoppedLead(input: StopBylineInput, tone: StateTone): ConversationRowSegment[] {
  const status = input.record?.status;
  if (status?.kind !== 'open') {
    const brief = input.parked?.taskId ?? input.currentTaskId;
    if (brief === null) return stopLeadParts('Stopped', tone);
    const cut: StepCut | undefined =
      input.parked?.kind === 'boundary'
        ? 'boundary'
        : input.parked?.kind === 'mid-brief'
          ? 'mid-step'
          : undefined;
    const kept = cut === 'mid-step' && (input.parked?.kept.length ?? 0) > 0;
    return stopLeadParts(
      'Stopped',
      tone,
      ` ${stopPoint({ kind: 'brief', taskId: taskId(brief), attempt: 0 }, cut)}`,
      kept ? PARTIAL_KEPT : undefined,
    );
  }
  const paused = status.stop.on.kind === 'paused' ? status.stop.on : undefined;
  const kept =
    status.resumeAt.kind === 'brief' && paused?.at === 'mid-step' && (paused.kept?.length ?? 0) > 0;
  return stopLeadParts(
    'Stopped',
    tone,
    ` ${stopPoint(status.resumeAt, paused?.at)}`,
    kept ? PARTIAL_KEPT : undefined,
  );
}

const PARTIAL_KEPT = 'Partial changes kept';

function stopLeadParts(
  state: string,
  tone: StateTone,
  cause = '',
  secondary?: string,
): ConversationRowSegment[] {
  return [
    { text: state, tone },
    ...separatedSpans(cause, 'text'),
    ...(secondary === undefined
      ? []
      : [
          { text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment,
          ...separatedSpans(secondary, 'textDim'),
        ]),
  ];
}

export function stopByline(input: StopBylineInput): StopByline | null {
  const tone = stateTone(input.phase === 'failed' ? 'failed' : 'attention');
  const byline = (
    parts: readonly ConversationRowSegment[],
    hint: string,
    clock?: string,
  ): StopByline => {
    return {
      tone,
      parts,
      hint,
      ...(clock === undefined ? {} : { clock }),
    };
  };
  const name = subject(input);

  if (input.intent === 'none') return null;

  if (input.phase === 'failed')
    return byline(
      stopLeadParts('Stop failed', tone, `${SOFT_SEP}${input.error ?? 'Cleanup did not finish'}`),
      '/stop to retry',
    );

  if (input.phase === 'parked') {
    if (input.parked?.kind === 'boundary') {
      const next: StepRef =
        input.nextTaskId === null
          ? { kind: 'review', cycle: 0 }
          : { kind: 'brief', taskId: taskId(input.nextTaskId), attempt: 0 };
      return byline(
        stopLeadParts(
          'Stopped',
          tone,
          ` ${stopPoint(next, 'boundary')}`,
          `${input.passed} of ${input.total} briefs complete`,
        ),
        PARKED_HINT,
      );
    }
    return byline(stoppedLead(input, tone), PARKED_HINT);
  }

  // End run closed the run: the closed run's own byline speaks for it.
  if (input.phase === 'ended') return null;

  if (input.intent === 'quit') {
    return byline(stopLeadParts('Quitting', tone), 'Stopping processes and saving session');
  }

  // A boundary pause kills nothing: the brief runs to its end, so the byline reports the finish
  // rather than a termination that is not happening.
  if (input.intent === 'pause-after-brief') {
    if (input.questionPending) {
      return byline(stopLeadParts('Answer needed', tone, ` to finish ${name}`), 'Pause requested');
    }
    const hint = 'Pause requested; no next brief will start';
    if (input.suite === null) return byline(stopLeadParts('Finishing', tone, ` ${name}`), hint);
    return byline(
      suiteStatusParts(input.workflowPhase, input.suite),
      hint,
      formatElapsedClock(input.suite.elapsedMs),
    );
  }

  const state = input.intent === 'end-run' ? 'Ending run' : 'Stopping';
  const cause = input.intent === 'end-run' ? '' : ` ${name}`;
  if (input.phase === 'forcing') {
    return byline(stopLeadParts(state, tone, cause, 'Forcing remaining processes to exit'), '');
  }
  const progress =
    input.phase === 'terminating'
      ? 'Waiting for processes to exit'
      : 'Finishing cleanup and saving';
  const clock = formatElapsedClock(input.elapsedMs);
  return byline(
    [
      ...stopLeadParts(state, tone, cause, progress),
      { text: SOFT_SEP, tone: 'textDim' },
      { text: clock, tone: 'textDim' },
    ],
    `esc back after stop${SOFT_SEP}ctrl+c quit after stop`,
  );
}
