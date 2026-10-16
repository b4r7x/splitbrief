import { stateTone, type StateTone } from '../../../core/theme/state-tone.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { RunStatus, StopReason } from '../../../core/sessions/run-status.js';
import type { SummaryView } from './view-model.js';
import { haltOf, recoveryHaltLabel } from '../../../core/recovery/halt.js';
import { recoveryHeadlineParts } from '../recovery-prompt.js';
import { formatResetAt } from '../../../core/recovery/reset-clock.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  segmentsForRowText,
} from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { stepWord, stopPoint } from '../stop/copy.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { separatedSpans } from '../conversation-rows/row-format/text.js';

/**
 * What the user can do next, and — when the run needs one — why. The action is held as it reads
 * standing alone; a reason clause leads the line and lowercases the action behind it.
 */
type Byline = { reason: readonly ConversationRowSegment[] | null; action: string };

const HOME_AGAIN = 'Start it again from home';

// The path is the Run block's Patch row; a byline cut at 80 columns would name no file.
const BRING_BACK = 'Bring the changes back with git apply on the Patch file';

/** One sentence for a line too narrow for both halves: the reason goes, the action stays. */
function fitByline(byline: Byline, width: number): readonly ConversationRowSegment[] {
  const { action } = byline;
  const reason = byline.reason?.map((part) => part.text).join('') ?? null;
  if (reason !== null && byline.reason !== null) {
    const whole = `${reason}${SOFT_SEP}${lowercaseLead(action)}`;
    if (getTerminalCellWidth(whole) <= width) {
      return [
        ...byline.reason,
        { text: SOFT_SEP, tone: 'textDim' },
        { text: lowercaseLead(action), tone: 'textDim' },
      ];
    }
    // A reason in parts leads with its name ("Seat down", "Stopped by an error"): keep that much.
    const lead = reason.split(SOFT_SEP)[0];
    if (lead !== undefined && lead !== reason) {
      const named = `${lead}${SOFT_SEP}${lowercaseLead(action)}`;
      if (getTerminalCellWidth(named) <= width) {
        return [
          ...segmentsForRowText(byline.reason, lead),
          { text: SOFT_SEP, tone: 'textDim' },
          { text: lowercaseLead(action), tone: 'textDim' },
        ];
      }
    }
  }
  if (getTerminalCellWidth(action) <= width) return [{ text: action, tone: 'textDim' }];
  return [{ text: truncateTerminalDisplayText(action, width), tone: 'textDim' }];
}

/**
 * The row under the composer of a closed run: what to do next, never what just happened. A line too
 * narrow for everything sheds the reason first.
 */
export function bylineParts(view: SummaryView, width: number): readonly ConversationRowSegment[] {
  if (view.applyUndo !== null) {
    return fitStatusByline(
      'Apply undone',
      view.applyUndo.conflicts.length > 0 ? 'your later edits were kept' : 'nothing left to undo',
      stateTone('attention'),
      width,
    );
  }
  if (view.checkpoint === 'accepted') {
    return fitStatusByline('Accepted', 'nothing left to do', stateTone('passed'), width);
  }
  if (view.checkpoint === 'rejected') {
    return fitStatusByline('Rejected', 'its files were restored', stateTone('attention'), width);
  }
  return fitByline(bylineFor(view), width);
}

function fitStatusByline(
  reason: string,
  action: string,
  reasonTone: StateTone,
  width: number,
): readonly ConversationRowSegment[] {
  const whole = action === '' ? reason : `${reason}${SOFT_SEP}${action}`;
  const fitted =
    getTerminalCellWidth(whole) <= width ? whole : truncateTerminalDisplayText(whole, width);
  return segmentsForRowText(
    [
      ...separatedSpans(reason, reasonTone),
      ...(action === ''
        ? []
        : ([
            { text: SOFT_SEP, tone: 'textDim' },
            { text: action, tone: 'textDim' },
          ] satisfies ConversationRowSegment[])),
    ],
    fitted,
  );
}

function lowercaseLead(sentence: string): string {
  return sentence.slice(0, 1).toLowerCase() + sentence.slice(1);
}

function bylineFor(view: SummaryView): Byline {
  const kind = view.outcome.kind;
  if (kind === 'applied' && view.canUndoApply) {
    return { reason: null, action: 'Undo the Apply with /run reject confirm' };
  }
  if (kind === 'ended') {
    return {
      reason: [{ text: 'Ended', tone: stateTone('attention') }],
      action: view.files.patch === null ? 'esc home' : BRING_BACK,
    };
  }
  if (view.files.patch !== null) return { reason: null, action: BRING_BACK };
  if (kind === 'needs-attention') return { reason: null, action: attentionByline(view) };
  // Going home is the legend's: a byline that only repeated it would say nothing.
  return { reason: null, action: '' };
}

/**
 * The composer placeholder, by what the run on screen will take. An open run's placeholder names
 * no ⏎ verb: what ⏎ does depends on the stop, and the byline under the composer names it.
 */
export const AT_REST_PLACEHOLDER = {
  open: 'Type a correction…',
  inputRequired: 'Type your answer…',
  closed: `/ for a command${SOFT_SEP}⏎ for home…`,
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

/**
 * The row under the composer of a run at rest: where it stopped, then the one key that moves it.
 * A run nothing can pick up says why before it says where to go.
 */
export function openRunBylineParts(
  input: Readonly<{ status: RunStatus; continuable: boolean; width: number }>,
): readonly ConversationRowSegment[] {
  const { status, width } = input;
  if (status.kind === 'running')
    return fitStatusByline(
      RUNNING_BYLINE.reason,
      RUNNING_BYLINE.action,
      RUNNING_BYLINE.tone,
      width,
    );
  if (status.kind === 'ready-to-apply') {
    return fitByline(
      {
        reason: [
          {
            text: status.override ? 'Ready to apply as is' : 'Ready to apply',
            tone: stateTone(status.override ? 'attention' : 'running'),
          },
        ],
        action: `Pick ${status.override ? 'Apply as is' : 'Apply'}, Show diff or Discard`,
      },
      width,
    );
  }
  if (status.kind === 'closed') {
    return fitByline({ reason: null, action: HOME_AGAIN }, width);
  }
  if (!input.continuable) return fitByline(UNREADABLE_BYLINE, width);
  return fitByline(openByline(status.stop, status.resumeAt), width);
}

function openByline(stop: StopReason, resumeAt: StepRef): Byline {
  switch (stop.on.kind) {
    case 'paused':
      return {
        reason: [
          { text: `Stopped ${stopPoint(resumeAt, stop.on.at)}`, tone: stateTone('attention') },
        ],
        action: 'Type a correction or ⏎ to continue',
      };
    // Only a typed plan's card reopens. An old run parked at a gate of the old chain continues as one
    // planning session, which takes a typed correction as its lead.
    case 'gate':
      return {
        reason: [{ text: `Waiting at ${stepWord(resumeAt)}`, tone: stateTone('attention') }],
        action: stop.on.reopens ? '⏎ to reopen it' : '⏎ to continue',
      };
    case 'question':
      return {
        reason: [{ text: 'Waiting for your answer', tone: stateTone('attention') }],
        action: 'Type a reply or ⏎ to continue',
      };
    case 'halt':
      return {
        reason: [
          { text: recoveryHaltLabel(haltOf(stop.on.issue.reason)), tone: stateTone('attention') },
          { text: SOFT_SEP, tone: 'textDim' },
          ...recoveryHeadlineParts(stop.on.issue),
        ],
        action: '⏎ to decide',
      };
    case 'failed':
      return {
        reason: [
          { text: 'Stopped by an error', tone: stateTone('failed') },
          { text: SOFT_SEP, tone: 'textDim' },
          ...separatedSpans(stop.on.message, 'text'),
        ],
        action: '⏎ to retry the step',
      };
    case 'seat-wait':
      return {
        reason: [{ text: `Waiting for ${stop.on.tool}`, tone: stateTone('attention') }],
        action: formatResetAt(stop.on.resetAt) ?? '⏎ to continue',
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

function attentionByline(view: SummaryView): string {
  const blocking = view.review.kind === 'written' ? view.review.counts.critical : 0;
  if (blocking > 0) {
    return `Read the ${countNoun(blocking, 'blocking finding')} in the packet`;
  }
  const scope = view.scope;
  const deviations = scope.kind === 'checked' && !scope.passed ? scope.errors + scope.warnings : 0;
  if (deviations > 0) {
    return `Check the ${countNoun(deviations, 'scope deviation')} in the packet`;
  }
  const failed = view.briefs.failed;
  if (failed > 0) {
    const briefs = failed === 1 ? 'the failed brief' : `the ${countNoun(failed, 'failed brief')}`;
    return `Fix ${briefs}`;
  }
  return '';
}

const LEGEND_KEYS = ['esc home', 'ctrl+k commands', '/sessions', '/help'] as const;
const SCROLL_KEY = 'shift+↑↓ scroll';

/**
 * `canGoHome` is false while something else on the screen owns Escape — a tool check beside the
 * composer, say. The key leaves the legend rather than promising an exit it would not take.
 */
export function legendText(
  input: Readonly<{ overflow: boolean; width: number; canGoHome?: boolean | undefined }>,
): string {
  const [home, ...rest] = LEGEND_KEYS;
  const lead = input.canGoHome === false ? [] : [home];
  const keys = input.overflow ? [...lead, SCROLL_KEY, ...rest] : [...lead, ...rest];
  return fitKeyLegend(keys.join(SOFT_SEP), input.width);
}
