import type { StepRef } from '../../../core/schemas/run-step.js';
import type { RunStatus, StopReason } from '../../../core/sessions/run-status.js';
import type { SummaryView } from './view-model.js';
import { formatRecoveryHeadline } from '../../../core/recovery/headline.js';
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
  if (view.checkpoint === 'accepted') {
    return { reason: null, action: `Accepted${SOFT_SEP}nothing left to do` };
  }
  if (view.checkpoint === 'rejected') {
    return { reason: null, action: `Rejected${SOFT_SEP}its files were restored` };
  }
  const kind = view.outcome.kind;
  if (kind === 'ready') {
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
  closed: `/ for a command${SOFT_SEP}⏎ for home…`,
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
  if (status.kind === 'closed') return fitByline({ reason: null, action: HOME_AGAIN }, width);
  if (!input.continuable) return fitByline(UNREADABLE_BYLINE, width);
  return fitByline(openByline(status.stop, status.resumeAt), width);
}

function openByline(stop: StopReason, resumeAt: StepRef): Byline {
  switch (stop.kind) {
    case 'paused':
      return {
        reason: `Paused at ${stepWord(resumeAt)}`,
        action: 'Type a correction or ⏎ to continue',
      };
    case 'waiting':
      return { reason: `Waiting at the ${stop.gate} gate`, action: '⏎ to reopen it' };
    case 'halted':
      return {
        reason: `Halted${SOFT_SEP}${formatRecoveryHeadline(stop.issue)}`,
        action: '⏎ to decide',
      };
    case 'failed':
      return {
        reason: `Stopped by an error${SOFT_SEP}${stop.message}`,
        action: '⏎ to retry the step',
      };
    default:
      return { reason: 'Interrupted', action: `⏎ to continue from ${stepWord(resumeAt)}` };
  }
}

/** A step in the words the rest of the screen uses for it: a brief by id, a call by its name. */
export function stepWord(step: StepRef): string {
  switch (step.kind) {
    case 'planner':
      return `the ${step.call} step`;
    case 'gate':
      return `the ${step.gate} gate`;
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
