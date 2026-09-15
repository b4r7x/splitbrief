import type { GlyphName } from '../../../lib/glyphs.js';
import type { ReviewView, ScopeView, SummaryView } from './view-model.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { isRailCurrent } from '../../../core/rail-stages.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { findingCounts, type CopyTone } from './copy.js';

/** The glyph slot every ledger row and the outcome line open with: marker plus its trailing space. */
const MARKER_CELLS = 2;

export function outcomeMarker(view: SummaryView): Readonly<{ glyph: GlyphName; tone: CopyTone }> {
  switch (view.outcome.kind) {
    case 'ready':
      return { glyph: 'check', tone: 'success' };
    case 'needs-attention':
      return { glyph: 'statusWarning', tone: 'warning' };
    default:
      return { glyph: 'statusCancelled', tone: 'warning' };
  }
}

/**
 * The one sentence the run ended on. `width` is the whole row, marker slot included, and a line too
 * narrow for every fact drops whole ` · ` tokens from the tail: half a fact states another fact.
 */
export function outcomeLine(view: SummaryView, width: number): string {
  const budget = Math.max(0, width - MARKER_CELLS);
  const segments = outcomeSegments(view);
  let kept = segments.length;
  while (kept > 1 && getTerminalCellWidth(joinSoft(segments, kept)) > budget) kept -= 1;
  return truncateTerminalDisplayText(joinSoft(segments, kept), budget);
}

function joinSoft(segments: readonly string[], kept: number): string {
  return segments.slice(0, kept).join(SOFT_SEP);
}

function outcomeSegments(view: SummaryView): string[] {
  const kind = view.outcome.kind;
  if (kind !== 'ended') return settledSegments(view, kind);
  if (view.briefs.total === 0) {
    return [ENDED_LEAD, stageWord(view), 'no briefs compiled', 'nothing built'];
  }
  const stoppedId = view.files.stoppedAt?.taskId ?? null;
  return [
    ENDED_LEAD,
    `${stageWord(view)} ${view.briefs.passed}/${view.briefs.total}`,
    ...(stoppedId === null ? [] : [`stopped in ${stoppedId}`]),
    haltedDisposition(view),
  ];
}

/** The one word a run somebody closed ends on; the rail wears the same cancel mark. */
const ENDED_LEAD = 'Ended';

function settledSegments(view: SummaryView, kind: 'ready' | 'needs-attention'): string[] {
  const failed = view.briefs.failed;
  return [
    kind === 'ready' ? 'Ready' : 'Needs attention',
    briefFraction(view),
    ...(kind === 'needs-attention' && failed > 0 ? [`${failed} failed`] : []),
    reviewFact(view.review),
    scopeFact(view.scope),
    filesFact(view),
  ];
}

function briefFraction(view: SummaryView): string {
  if (view.briefs.total === 0) return 'no briefs';
  return `${view.briefs.passed}/${view.briefs.total} briefs passed`;
}

/** The stage the rail froze on, read off the rail itself so the two never name different stages. */
function stageWord(view: SummaryView): string {
  const halted = view.rail.find((state) => isRailCurrent(state.status));
  const stage = halted?.stage ?? view.rail.find((state) => state.status === 'pending')?.stage;
  return stage === undefined ? '' : formatStageLabel(stage);
}

function haltedDisposition(view: SummaryView): string {
  if (view.files.changed === null) return 'files not recorded';
  if (view.files.partial.size > 0) return 'partial changes kept';
  if (view.files.changed.length > 0) return 'changes kept';
  return 'nothing built';
}

function filesFact(view: SummaryView): string {
  if (view.briefs.total === 0) return 'nothing built';
  if (view.files.changed === null) return 'files not recorded';
  if (view.files.changed.length === 0) return 'no files changed';
  return `${countNoun(view.files.changed.length, 'file')} changed`;
}

function reviewFact(review: ReviewView): string {
  if (review.kind !== 'written') return 'review not run';
  const counts = findingCounts(review.counts);
  return review.verdict === 'fail' ? `review failed ${counts}` : `review ${counts}`;
}

function scopeFact(scope: ScopeView): string {
  if (scope.kind === 'not-run') return 'scope not checked';
  const deviations = scope.errors + scope.warnings;
  return deviations === 0 ? 'scope clean' : `scope ${countNoun(deviations, 'deviation')}`;
}
