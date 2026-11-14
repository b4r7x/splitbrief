import { stateTone, type StateTone } from '../../../core/theme/state-tone.js';
import type { SummaryView } from './view-model.js';
import { fitKeyLegend } from '../../../components/key-legend.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { segmentsForRowText } from '../../../utils/display-text/width.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { countNoun } from '../../../utils/pluralize.js';
import { formatDatedClock } from '../../../utils/format/time.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { separatedSpans } from '../conversation-rows/row-format/text.js';

/**
 * What the user can do next, and — when the run needs one — why. The action is held as it reads
 * standing alone; a reason clause leads the line and lowercases the action behind it.
 */
export type Byline = { reason: readonly ConversationRowSegment[] | null; action: string };

// The path is the Run block's Patch row; a byline cut at 80 columns would name no file.
const BRING_BACK = 'Bring the changes back with git apply on the Patch file';

/** One sentence for a line too narrow for both halves: the reason goes, the action stays. */
export function fitByline(byline: Byline, width: number): readonly ConversationRowSegment[] {
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
  if (view.checkpoint?.kind === 'accepted') {
    return fitStatusByline('Accepted', 'nothing left to do', stateTone('passed'), width);
  }
  if (view.checkpoint?.kind === 'rejected') {
    return fitStatusByline('Rejected', 'its files were restored', stateTone('attention'), width);
  }
  return fitByline(bylineFor(view), width);
}

export function fitStatusByline(
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

export function lowercaseLead(sentence: string): string {
  return sentence.slice(0, 1).toLowerCase() + sentence.slice(1);
}

function bylineFor(view: SummaryView): Byline {
  const kind = view.outcome.kind;
  if (kind === 'applied' && view.canUndoApply) {
    return { reason: null, action: 'Undo the Apply with /run reject confirm' };
  }
  if (kind === 'ended' && view.files.patch !== null) {
    return { reason: [{ text: 'Ended', tone: stateTone('attention') }], action: BRING_BACK };
  }
  if (view.files.patch !== null) return { reason: null, action: BRING_BACK };
  if (kind === 'needs-attention') return { reason: null, action: attentionByline(view) };
  // Going home is the legend's: a byline that only repeated it would say nothing.
  return { reason: null, action: '' };
}

/**
 * The words on the rule that ends a closed run's transcript: that it closed, and when. The time is
 * always dated, so it reads right on any later day without a clock.
 */
export function runClosedLabel(closedAt: number | null): string {
  return closedAt === null ? 'Run closed' : `Run closed${SOFT_SEP}${formatDatedClock(closedAt)}`;
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
 * `canOpenCommands` is false while a tool check to continue the run holds the app shortcuts:
 * ctrl+k leaves the legend rather than naming a key that does nothing.
 */
export function legendText(
  input: Readonly<{
    overflow: boolean;
    width: number;
    canGoHome?: boolean | undefined;
    canOpenCommands?: boolean | undefined;
  }>,
): string {
  const [home, commands, ...rest] = LEGEND_KEYS;
  const keys = [
    ...(input.canGoHome === false ? [] : [home]),
    ...(input.overflow ? [SCROLL_KEY] : []),
    ...(input.canOpenCommands === false ? [] : [commands]),
    ...rest,
  ];
  return fitKeyLegend(keys.join(SOFT_SEP), input.width);
}
