import type { StepRef } from '../../../core/schemas/run-step.js';
import type { RunStatus, StopReason } from '../../../core/sessions/run-status.js';
import type { SummaryView } from './view-model.js';
import { formatRecoveryHeadline, formatRecoveryTitle } from '../../../core/recovery/headline.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';

const REVERT = 'revert it with /run reject confirm';
const ALTERNATIVE = ', or ';

/**
 * What the user can do next, and — when the run needs one — why. The action is held as it reads
 * standing alone; a reason clause leads the line and lowercases the action behind it.
 */
interface Byline {
  reason: string | null;
  action: string;
}

const HOME_AGAIN = 'Start it again from home';

/** One sentence for a line too narrow for both halves: the reason goes, the action stays. */
function fitByline(byline: Byline, width: number): string {
  const { reason, action } = byline;
  if (reason !== null) {
    const whole = `${reason}${SOFT_SEP}${lowercaseLead(action)}`;
    if (getTerminalCellWidth(whole) <= width) return whole;
    // A reason in parts leads with its name ("Seat down", "Stopped by an error"): keep that much.
    const lead = reason.split(SOFT_SEP)[0];
    if (lead !== undefined && lead !== reason) {
      const named = `${lead}${SOFT_SEP}${lowercaseLead(action)}`;
      if (getTerminalCellWidth(named) <= width) return named;
    }
  }
  if (getTerminalCellWidth(action) <= width) return action;
  const at = action.indexOf(ALTERNATIVE);
  const primary = at === -1 ? action : action.slice(0, at);
  if (getTerminalCellWidth(primary) <= width) return primary;
  return truncateTerminalDisplayText(primary, width);
}

/**
 * The row under the composer of a closed run: what to do next, never what just happened. A line too
 * narrow for everything sheds the reason first and the alternative second.
 */
export function bylineText(view: SummaryView, width: number): string {
  return fitByline(bylineFor(view), width);
}

function lowercaseLead(sentence: string): string {
  return sentence.slice(0, 1).toLowerCase() + sentence.slice(1);
}

function bylineFor(view: SummaryView): Byline {
  if (view.applyUndo !== null) {
    return {
      reason: null,
      action: `Apply undone${SOFT_SEP}${view.applyUndo.conflicts.length > 0 ? 'your later edits were kept' : 'nothing left to undo'}`,
    };
  }
  if (view.checkpoint === 'accepted') {
    return { reason: null, action: `Accepted${SOFT_SEP}nothing left to do` };
  }
  if (view.checkpoint === 'rejected') {
    return { reason: null, action: `Rejected${SOFT_SEP}its files were restored` };
  }
  const kind = view.outcome.kind;
  if (kind === 'applied') {
    return { reason: null, action: 'Undo the Apply with /run reject confirm' };
  }
  // The path is the Run block's Patch row; a byline cut at 80 columns would name no file.
  if (view.files.patch !== null) {
    return { reason: null, action: 'Bring the changes back with git apply on the Patch file' };
  }
  if (kind === 'complete') {
    return { reason: null, action: `Keep it with /run accept${ALTERNATIVE}${REVERT}` };
  }
  if (kind === 'needs-attention') return { reason: null, action: attentionByline(view) };
  return { reason: null, action: 'esc home' };
}

/** The line a closed run with no record of its own can still say honestly. */
export const NO_RECORD_LINE = 'Ended · no run record was written';

/** The composer placeholder, by what the run on screen will take. */
export const AT_REST_PLACEHOLDER = {
  open: 'Type a correction, or ⏎ to continue…',
  inputRequired: 'Type your answer, or ⏎ to continue…',
  closed: `/ for a command${SOFT_SEP}⏎ for home…`,
  ready: `/ for a command${SOFT_SEP}tab for the result menu…`,
} as const;

const UNREADABLE_BYLINE: Byline = {
  reason: 'Saved state unreadable',
  action: HOME_AGAIN,
};

const RUNNING_BYLINE: Byline = {
  reason: null,
  action: 'Running in another process',
};

/**
 * The row under the composer of a run at rest: where it stopped, then the one key that moves it.
 * A run nothing can pick up says why before it says where to go.
 */
export function openRunByline(
  input: Readonly<{ status: RunStatus; continuable: boolean; width: number }>,
): string {
  const { status, width } = input;
  if (status.kind === 'running') return fitByline(RUNNING_BYLINE, width);
  if (status.kind === 'ready-to-apply') {
    return fitByline(
      {
        reason: status.override ? 'Ready to apply as is' : 'Ready to apply',
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
        reason: `Stopped at ${stepWord(resumeAt)}`,
        action: 'Type a correction or ⏎ to continue',
      };
    // Only a typed plan's card reopens. An old run parked at a gate of the old chain continues as one
    // planning session, which takes a typed correction as its lead.
    case 'gate':
      return {
        reason: `Waiting at ${stepWord(resumeAt)}`,
        action: stop.on.reopens ? '⏎ to reopen it' : '⏎ to continue',
      };
    case 'question':
      return { reason: 'Waiting for your answer', action: 'Type a reply or ⏎ to continue' };
    case 'halt':
      return {
        reason: formatRecoveryTitle(formatRecoveryHeadline(stop.on.issue), stop.on.issue),
        action: '⏎ to decide',
      };
    case 'failed':
      return {
        reason: `Stopped by an error${SOFT_SEP}${stop.on.message}`,
        action: '⏎ to retry the step',
      };
    default:
      return { reason: `Stopped at ${stepWord(resumeAt)}`, action: '⏎ to continue' };
  }
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

function attentionByline(view: SummaryView): string {
  const blocking = view.review.kind === 'written' ? view.review.counts.critical : 0;
  if (blocking > 0) {
    return `Read the ${countNoun(blocking, 'blocking finding')} in the packet${ALTERNATIVE}${REVERT}`;
  }
  const scope = view.scope;
  const deviations = scope.kind === 'checked' && !scope.passed ? scope.errors + scope.warnings : 0;
  if (deviations > 0) {
    return `Check the ${countNoun(deviations, 'scope deviation')} in the packet${ALTERNATIVE}${REVERT}`;
  }
  const failed = view.briefs.failed;
  if (failed > 0) {
    const briefs = failed === 1 ? 'the failed brief' : `the ${countNoun(failed, 'failed brief')}`;
    return `Fix ${briefs}${ALTERNATIVE}${REVERT}`;
  }
  return `Keep it with /run accept${ALTERNATIVE}${REVERT}`;
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
