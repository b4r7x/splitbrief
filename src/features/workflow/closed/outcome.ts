import { glyph, type GlyphName } from '../../../lib/glyphs.js';
import { ROW_LEADING } from '../../../components/row-leading.js';
import type { ReviewView, ScopeView, SummaryView } from './view-model.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { isRailCurrent } from '../../../core/rail-stages.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { findingCounts, type CopyTone } from './copy.js';
import { stopPoint } from '../stop/copy.js';

// The transcript's leading: the shared one-cell pad the hover bar paints into, then the outcome mark
// and its trailing space. The mark lands on column 1 with the sentence on column 3, matching a
// brief's own row, and the `width` a caller passes is the whole row, marker slot included.
export function outcomeLeading(mark: string): string {
  return `${ROW_LEADING}${mark} `;
}

export const OUTCOME_LEADING_CELLS = getTerminalCellWidth(outcomeLeading(glyph('statusCancelled')));

export function outcomeMarker(view: SummaryView): Readonly<{ glyph: GlyphName; tone: CopyTone }> {
  switch (view.outcome.kind) {
    case 'applied':
      if (view.applyUndo !== null) return { glyph: 'statusCancelled', tone: 'warning' };
      return { glyph: 'stageDone', tone: 'success' };
    case 'complete':
      return { glyph: 'stageDone', tone: 'success' };
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
  const budget = Math.max(0, width - OUTCOME_LEADING_CELLS);
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
  if (kind === 'applied') return appliedSegments(view);
  if (kind === 'discarded') return discardedSegments(view);
  if (kind !== 'ended') return settledSegments(view, kind);
  if (view.briefs.total === 0) {
    const earlierWork = view.briefs.earlierRows.length > 0 || (view.files.changed?.length ?? 0) > 0;
    return [
      ENDED_LEAD,
      stageWord(view),
      earlierWork ? 'no current briefs' : 'no briefs compiled',
      haltedDisposition(view),
    ];
  }
  const stoppedId = view.files.stoppedAt?.taskId ?? null;
  const stage = stageWord(view);
  return [
    ENDED_LEAD,
    stage === '' ? briefFraction(view) : `${stage} ${view.briefs.passed}/${view.briefs.total}`,
    ...(stoppedId === null
      ? []
      : [`stopped ${stopPoint({ kind: 'brief', taskId: stoppedId, attempt: 0 }, undefined)}`]),
    haltedDisposition(view),
  ];
}

/** The one word a run somebody closed ends on; the rail wears the same cancel mark. */
const ENDED_LEAD = 'Ended';

function settledSegments(view: SummaryView, kind: 'complete' | 'needs-attention'): string[] {
  const failed = view.briefs.failed;
  return [
    kind === 'complete' ? 'Complete' : 'Needs attention',
    briefFraction(view),
    ...(kind === 'needs-attention' && failed > 0 ? [`${failed} failed`] : []),
    reviewFact(view.review),
    scopeFact(view.scope),
    filesFact(view),
  ];
}

function appliedSegments(view: SummaryView): string[] {
  if (view.applyUndo !== null)
    return ['Apply undone', briefFraction(view), reviewFact(view.review), scopeFact(view.scope)];
  const changed = view.files.changed;
  return [
    'Applied',
    briefFraction(view),
    reviewFact(view.review),
    scopeFact(view.scope),
    changed === null || changed.length === 0
      ? filesFact(view)
      : `${countNoun(changed.length, 'file')} applied`,
  ];
}

function discardedSegments(view: SummaryView): string[] {
  const changed = view.files.changed;
  return [
    'Discarded',
    briefFraction(view),
    changed === null || changed.length === 0
      ? filesFact(view)
      : `${countNoun(changed.length, 'file')} saved in run.patch`,
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
  if (view.files.changed === null)
    return stoppedBeforeBuild(view) && view.briefs.earlierRows.length === 0
      ? 'nothing built'
      : 'files not recorded';
  if (view.files.patch !== null) return 'changes saved in run.patch';
  if (view.files.partial.size > 0) return 'partial changes kept';
  if (view.files.changed.length > 0) return 'changes kept';
  return 'nothing built';
}

/** The rail froze before Build, so no brief started: a run with no changed set built nothing. */
function stoppedBeforeBuild(view: SummaryView): boolean {
  return view.rail.find((state) => state.stage === 'build')?.status === 'pending';
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
