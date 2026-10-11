import { glyph, type GlyphName } from '../../../lib/glyphs.js';
import { ROW_LEADING } from '../../../components/row-leading.js';
import type { ReviewView, ScopeView, SummaryView } from './view-model.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { isRailCurrent, railStageSeat } from '../../../core/rail-stages.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { SOFT_SEP } from '../../../core/separators.js';
import {
  getTerminalCellWidth,
  segmentsForRowText,
  truncateTerminalDisplayText,
} from '../../../utils/display-text.js';
import { countNoun } from '../../../utils/pluralize.js';
import { findingCounts, scopeCleanSegment, type CopyTone } from './copy.js';
import { stopPoint } from '../stop/copy.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { passedFractionSpans } from '../display/build-progress.js';

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
      if (view.applyUndo !== null)
        return { glyph: 'statusCancelled', tone: stateTone('attention') };
      return { glyph: 'stageDone', tone: stateTone('passed') };
    case 'complete':
      return { glyph: 'stageDone', tone: stateTone('passed') };
    case 'needs-attention':
      return { glyph: 'statusWarning', tone: stateTone('attention') };
    default:
      return { glyph: 'statusCancelled', tone: stateTone('attention') };
  }
}

type OutcomeSpan = Readonly<{ text: string; seat?: CrewSeatId; tone: CopyTone }>;

/** The sentence fits whole facts from its head; width includes the marker slot. */
export function outcomeLineSpans(view: SummaryView | null, width: number): readonly OutcomeSpan[] {
  if (view === null)
    return [
      { text: ENDED_LEAD, tone: stateTone('attention') },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: 'no run record was written', tone: 'textDim' },
    ];
  const budget = Math.max(0, width - OUTCOME_LEADING_CELLS);
  const segments = outcomeSegments(view);
  let kept = segments.length;
  while (
    kept > 1 &&
    getTerminalCellWidth(
      joinSoft(segments, kept)
        .map((span) => span.text)
        .join(''),
    ) > budget
  )
    kept -= 1;
  const spans = joinSoft(segments, kept);
  const fitted = truncateTerminalDisplayText(spans.map((span) => span.text).join(''), budget);
  return segmentsForRowText(spans, fitted);
}

function joinSoft(segments: readonly (readonly OutcomeSpan[])[], kept: number): OutcomeSpan[] {
  return segments
    .slice(0, kept)
    .flatMap((fact, index) => [
      ...(index === 0 ? [] : [{ text: SOFT_SEP, tone: 'textDim' } satisfies OutcomeSpan]),
      ...fact,
    ]);
}

function secondaryFact(text: string): OutcomeSpan[] {
  return [{ text, tone: 'textDim' }];
}

function outcomeSegments(view: SummaryView): OutcomeSpan[][] {
  const kind = view.outcome.kind;
  if (kind === 'applied') return appliedSegments(view);
  if (kind === 'discarded') return discardedSegments(view);
  if (kind !== 'ended') return settledSegments(view, kind);
  if (view.briefs.total === 0) {
    const earlierWork = view.briefs.earlierRows.length > 0 || (view.files.changed?.length ?? 0) > 0;
    return [
      [{ text: ENDED_LEAD, tone: stateTone('attention') }],
      stageWord(view),
      secondaryFact(earlierWork ? 'no current briefs' : 'no briefs compiled'),
      secondaryFact(haltedDisposition(view)),
    ];
  }
  const stoppedId = view.files.stoppedAt?.taskId ?? null;
  const stage = stageWord(view);
  return [
    [{ text: ENDED_LEAD, tone: stateTone('attention') }],
    stage.length === 0
      ? briefFraction(view)
      : [...stage, { text: ` ${view.briefs.passed}/${view.briefs.total}`, tone: 'textDim' }],
    ...(stoppedId === null
      ? []
      : [
          [
            { text: 'stopped', tone: stateTone('attention') } satisfies OutcomeSpan,
            ...secondaryFact(
              ` ${stopPoint({ kind: 'brief', taskId: stoppedId, attempt: 0 }, undefined)}`,
            ),
          ],
        ]),
    secondaryFact(haltedDisposition(view)),
  ];
}

/** The one word a run somebody closed ends on; the rail wears the same cancel mark. */
const ENDED_LEAD = 'Ended';

function settledSegments(view: SummaryView, kind: 'complete' | 'needs-attention'): OutcomeSpan[][] {
  const failed = view.briefs.failed;
  return [
    [
      {
        text: kind === 'complete' ? 'Complete' : 'Needs attention',
        tone: outcomeMarker(view).tone,
      },
    ],
    briefFraction(view),
    ...(kind === 'needs-attention' && failed > 0
      ? [[{ text: `${failed} failed`, tone: stateTone('failed') } satisfies OutcomeSpan]]
      : []),
    reviewFact(view.review),
    scopeFact(view.scope),
    secondaryFact(filesFact(view)),
  ];
}

function appliedSegments(view: SummaryView): OutcomeSpan[][] {
  if (view.applyUndo !== null)
    return [
      [{ text: 'Apply undone', tone: stateTone('attention') }],
      briefFraction(view),
      reviewFact(view.review),
      scopeFact(view.scope),
    ];
  const changed = view.files.changed;
  return [
    [{ text: 'Applied', tone: stateTone('passed') }],
    briefFraction(view),
    reviewFact(view.review),
    scopeFact(view.scope),
    changed === null || changed.length === 0
      ? secondaryFact(filesFact(view))
      : [
          ...secondaryFact(`${countNoun(changed.length, 'file')} `),
          { text: 'applied', tone: stateTone('passed') },
        ],
  ];
}

function discardedSegments(view: SummaryView): OutcomeSpan[][] {
  const changed = view.files.changed;
  return [
    [{ text: 'Discarded', tone: stateTone('attention') }],
    briefFraction(view),
    secondaryFact(
      changed === null || changed.length === 0
        ? filesFact(view)
        : `${countNoun(changed.length, 'file')} saved in run.patch`,
    ),
  ];
}

function briefFraction(view: SummaryView): OutcomeSpan[] {
  if (view.briefs.total === 0) return secondaryFact('no briefs');
  return passedFractionSpans(`${view.briefs.passed}/${view.briefs.total} briefs`);
}

/** The stage the rail froze on, read off the rail itself so the two never name different stages. */
function stageWord(view: SummaryView): OutcomeSpan[] {
  const halted = view.rail.find((state) => isRailCurrent(state.status));
  const stage = halted?.stage ?? view.rail.find((state) => state.status === 'pending')?.stage;
  if (stage === undefined) return [];
  const seat = railStageSeat(stage);
  return [{ text: formatStageLabel(stage), ...(seat === null ? {} : { seat }), tone: 'textDim' }];
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

function reviewFact(review: ReviewView): OutcomeSpan[] {
  if (review.kind !== 'written') return secondaryFact('review not run');
  const counts = findingCounts(review.counts);
  return review.verdict === 'fail'
    ? [
        ...secondaryFact('review '),
        { text: 'failed', tone: stateTone('failed') },
        ...secondaryFact(` ${counts}`),
      ]
    : secondaryFact(`review ${counts}`);
}

function scopeFact(scope: ScopeView): OutcomeSpan[] {
  if (scope.kind === 'not-run') return secondaryFact('scope not checked');
  const clean = scopeCleanSegment(scope);
  return clean === null
    ? secondaryFact(`scope ${countNoun(scope.errors + scope.warnings, 'deviation')}`)
    : [...secondaryFact('scope '), clean];
}
