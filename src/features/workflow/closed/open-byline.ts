import { recoveryHaltLabel, haltOf } from '../../../core/recovery/halt.js';
import { statusLeavesWordsUnread } from '../../../core/recovery/typed-words.js';
import type { ViewSeatWait } from '../../../core/run-view/reduce.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import { SOFT_SEP } from '../../../core/separators.js';
import type { RunOwner } from '../../../core/sessions/run/record.js';
import type { RunStatus, StopReason } from '../../../core/sessions/run/status.js';
import { seatWaitParts } from '../../../core/sessions/seat-wait-line.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import type { DepartureKind } from '../../../stores/workflow/departure.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth, segmentsForRowText } from '../../../utils/display-text/width.js';
import { formatElapsedClock } from '../../../utils/format/time.js';
import { separatedSpans } from '../conversation-rows/row-format/text.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { stopPoint, stepWord } from '../display/step-words.js';
import { recoveryHeadlineParts } from '../recovery/headline.js';
import { recoveryMenuActionLabel } from '../recovery/menu-label.js';
import { type Byline, fitByline, fitStatusByline, lowercaseLead } from './byline.js';

const HOME_AGAIN = 'Start it again from home';

/**
 * The composer placeholder, by what the run on screen will take. An open run's placeholder names
 * no ⏎ verb: what ⏎ does depends on the stop, and the byline under the composer names it.
 */
export const AT_REST_PLACEHOLDER = {
  open: 'Type a correction…',
  noWords: '/ for a command…',
  inputRequired: 'Type your answer…',
  applying: `/ for a command${SOFT_SEP}⏎ for home when Apply finishes…`,
  quitting: '/ for a command…',
  ready: `/ for a command${SOFT_SEP}tab for the result menu…`,
} as const;

const UNREADABLE_BYLINE: Byline = {
  reason: [{ text: 'Saved state unreadable', tone: stateTone('failed') }],
  action: HOME_AGAIN,
};

const RUNNING_BYLINE = {
  reason: 'Running in another process',
  tone: stateTone('running'),
  action: '',
};

/** An Apply writing the run's result to the checkout: how long it has run, and what waits for it. */
export interface ApplyByline {
  elapsedMs: number;
  queued: DepartureKind | null;
}

const QUEUED_AFTER_APPLY: Record<DepartureKind, string> = {
  home: 'Returns home when Apply finishes',
  quit: 'Quits when Apply finishes',
};

/**
 * Apply has no safe cancel, so its byline offers no key; its clock proves it is alive. A line too
 * narrow for every word keeps the clock and, once a key queued a departure, says where it goes.
 */
export function applyByline(apply: ApplyByline, width: number): readonly ConversationRowSegment[] {
  const clock = `${SOFT_SEP}${formatElapsedClock(apply.elapsedMs)}`;
  const budget = Math.max(1, width - getTerminalCellWidth(clock));
  const reason: ConversationRowSegment = {
    text: 'Applying to your checkout',
    tone: stateTone('running'),
  };
  const queued: ConversationRowSegment | null =
    apply.queued === null ? null : { text: QUEUED_AFTER_APPLY[apply.queued], tone: 'textDim' };
  const whole: ConversationRowSegment[] =
    queued === null ? [reason] : [reason, { ...queued, text: `${SOFT_SEP}${queued.text}` }];
  const fitted =
    queued === null || getTerminalCellWidth(whole.map((span) => span.text).join('')) <= budget
      ? whole
      : [queued];
  const words = truncateTerminalDisplayText(fitted.map((span) => span.text).join(''), budget);
  return [...segmentsForRowText(fitted, words), { text: clock, tone: 'textDim' }];
}

/**
 * The row under the composer of a run at rest: where it stopped, then the one key that moves it.
 * A run nothing can pick up says why before it says where to go.
 */
export function openRunBylineParts(
  input: Readonly<{
    status: RunStatus;
    owner?: RunOwner | undefined;
    waitingForAnswer?: boolean;
    observing?: boolean;
    /** The seat wait the run's log states, already dropped for an open run whose seat moved. */
    wait: ViewSeatWait | null;
    /** The run view's `planCard`: a gate stop on a typed plan's card reopens it. */
    planCard: boolean;
    /** The run view's `failure`: the message of the error the run stopped on. */
    failure: string | null;
    continuable: boolean;
    width: number;
    now: number;
    apply?: ApplyByline | undefined;
    /** The Apply as is confirmation is open, so its two rows are the only ones on the screen. */
    confirming?: boolean | undefined;
  }>,
): readonly ConversationRowSegment[] {
  const { status, width, now } = input;
  if (input.owner?.kind === 'stale') {
    return fitStatusByline(
      'Viewing last saved activity',
      'Run is unresponsive',
      stateTone('attention'),
      width,
    );
  }
  // A wait whose reset has passed reads as the stop it now is.
  const wait =
    input.wait === null ? null : seatWaitParts(input.wait.tool, input.wait.wait.resetAt, now);
  if (status.kind === 'running' && input.apply !== undefined)
    return applyByline(input.apply, width);
  if (status.kind === 'running') {
    if (input.waitingForAnswer === true) {
      return fitStatusByline(
        'Waiting for an answer in another terminal',
        'View only',
        stateTone('attention'),
        width,
      );
    }
    // Another process waits on it now; a wait a steer cut there shows the running line.
    if (input.wait?.live === true && wait !== null) return fitByline(waitByline(wait), width);
    if (input.owner?.kind === 'live') {
      return fitStatusByline(
        'Viewing live',
        'Another terminal controls this run',
        stateTone('running'),
        width,
      );
    }
    return fitStatusByline(
      RUNNING_BYLINE.reason,
      RUNNING_BYLINE.action,
      RUNNING_BYLINE.tone,
      width,
    );
  }
  if (status.kind === 'ready-to-apply') {
    return fitByline(
      {
        reason: [
          {
            text: status.override ? 'Ready to apply as is' : 'Ready to apply',
            tone: stateTone(status.override ? 'attention' : 'running'),
          },
        ],
        action:
          input.confirming === true
            ? 'Pick Apply as is or Back'
            : `Pick ${status.override ? 'Apply as is' : 'Apply'}, Show diff or Discard`,
      },
      width,
    );
  }
  if (status.kind === 'closed') {
    return fitByline({ reason: null, action: HOME_AGAIN }, width);
  }
  if (!input.continuable) return fitByline(UNREADABLE_BYLINE, width);
  // A halt, a question and a gate wait for you and keep their own line.
  if (status.stop.kind === 'stopped' && wait !== null) return fitByline(waitByline(wait), width);
  return fitByline(
    openByline(status.stop, status.resumeAt, {
      reviewNone: status.reviewNone === true,
      ...input,
      wordsUnread: input.observing === true || statusLeavesWordsUnread(status),
    }),
    width,
  );
}

function openByline(
  stop: StopReason,
  resumeAt: StepRef,
  {
    planCard,
    failure,
    wordsUnread,
    reviewNone,
  }: Readonly<{
    planCard: boolean;
    failure: string | null;
    wordsUnread: boolean;
    reviewNone: boolean;
  }>,
): Byline {
  switch (stop.on.kind) {
    case 'paused':
      return {
        reason: [
          { text: `Stopped ${stopPoint(resumeAt, stop.on.at)}`, tone: stateTone('attention') },
        ],
        action: wordsUnread ? '⏎ to continue' : 'Type a correction or ⏎ to continue',
      };
    // Only a typed plan's card reopens. An old run parked at a gate of the old chain continues as one
    // planning session, which takes a typed correction as its lead.
    case 'gate':
      return {
        reason: [{ text: `Waiting at ${stepWord(resumeAt)}`, tone: stateTone('attention') }],
        action: planCard ? '⏎ to reopen it' : '⏎ to continue',
      };
    case 'question':
      return {
        reason: [{ text: 'Waiting for your answer', tone: stateTone('attention') }],
        action: wordsUnread ? '⏎ to continue' : 'Type a reply or ⏎ to continue',
      };
    case 'halt':
      return {
        reason: [
          { text: recoveryHaltLabel(haltOf(stop.on.issue.reason)), tone: stateTone('attention') },
          { text: SOFT_SEP, tone: 'textDim' },
          ...recoveryHeadlineParts(stop.on.issue),
        ],
        action: haltAction(stop.on.issue, reviewNone),
      };
    case 'failed':
      return {
        reason: [
          { text: 'Stopped by an error', tone: stateTone('failed') },
          ...(failure === null
            ? []
            : [
                { text: SOFT_SEP, tone: 'textDim' } satisfies ConversationRowSegment,
                ...separatedSpans(failure, 'text'),
              ]),
        ],
        action: '⏎ to retry the step',
      };
    default:
      return {
        reason: [
          { text: `Stopped ${stopPoint(resumeAt, undefined)}`, tone: stateTone('attention') },
        ],
        action: '⏎ to continue',
      };
  }
}

function waitByline([waiting, resets]: readonly [string, string]): Byline {
  return { reason: [{ text: waiting, tone: stateTone('attention') }], action: resets };
}

/**
 * A halt whose action was chosen and saved before the process died replays that action on ⏎
 * (`createRecoveryDriver`), so the byline names it instead of offering a choice.
 */
function haltAction(issue: RecoveryIssue, reviewNone: boolean): string {
  if (issue.status !== 'applying' || issue.selectedAction === undefined) return '⏎ to decide';
  return `⏎ to ${lowercaseLead(recoveryMenuActionLabel(issue.selectedAction, issue, reviewNone))}`;
}
