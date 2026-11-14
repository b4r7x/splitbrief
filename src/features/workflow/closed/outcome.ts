import type { GlyphName } from '../../../lib/glyphs.js';
import type { ReviewView, ScopeView, SummaryView } from './view-model.js';
import { formatStageLabel } from '../../../core/phases/labels.js';
import { isRailCurrent, railStageSeat } from '../../../core/phases/rail.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { segmentsForRowText } from '../../../utils/display-text/width.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { formatTime } from '../../../utils/format/time.js';
import { countNoun } from '../../../utils/pluralize.js';
import { formatApplyRestoreCounts } from '../../../core/runtime/commands/messages.js';
import { scopeCleanSegment } from './copy/change-facts.js';
import { unwrittenReviewText } from './copy/review-facts.js';
import type { CopyTone } from './copy/types.js';
import { findingFacts } from '../../../core/review/verdict.js';
import { stopPoint } from '../display/step-words.js';
import { stateTone } from '../../../core/theme/state-tone.js';
import { passedFractionSpans } from '../display/build-progress/counts.js';
import { rowLeadingCells } from '../conversation-rows/row-format/markers.js';
import { fitFacts } from './fit-facts.js';

/** Null is a run that closed without a record: it wears the mark of a run somebody ended. */
export function outcomeMarker(
  view: SummaryView | null,
): Readonly<{ glyph: GlyphName; tone: CopyTone }> {
  if (view === null) return { glyph: 'statusCancelled', tone: stateTone('attention') };
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

/** Two spaces part the verdict from its facts, the way a transcript header parts its title. */
const VERDICT_GAP = '  ';

/**
 * The verdict, then the facts the row seats whole; `width` is the whole row, marker slot included.
 * A row too narrow for one fact keeps the verdict alone.
 */
export function outcomeLineSpans(view: SummaryView | null, width: number): readonly OutcomeSpan[] {
  const segments: OutcomeSpan[][] =
    view === null
      ? [
          [{ text: ENDED_LEAD, tone: stateTone('attention') }],
          secondaryFact('no run record was written'),
        ]
      : outcomeSegments(view);
  const [verdict = [], ...facts] = segments;
  const budget = Math.max(0, width - rowLeadingCells('activity'));
  const lead = verdict.map((span) => span.text).join('');
  const fitted = fitFacts(facts, budget - getTerminalCellWidth(lead) - VERDICT_GAP.length);
  if (fitted.length === 0)
    return segmentsForRowText(verdict, truncateTerminalDisplayText(lead, budget));
  return [...verdict, { text: VERDICT_GAP, tone: 'textDim' }, ...fitted];
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
  // The stage rows under this line state the briefs, the review and the scope.
  return [
    [{ text: 'Applied to your checkout', tone: stateTone('passed') }],
    secondaryFact(
      changed === null || changed.length === 0
        ? filesFact(view)
        : countNoun(changed.length, 'file'),
    ),
    ...(view.ran === null ? [] : [secondaryFact(formatTime(view.ran))]),
  ];
}

function discardedSegments(view: SummaryView): OutcomeSpan[][] {
  return [
    [{ text: 'Discarded', tone: stateTone('attention') }],
    briefFraction(view),
    secondaryFact(discardedFilesFact(view)),
  ];
}

/** Where a discarded run's changes went: back out of the checkout a reject put, or its run.patch. */
function discardedFilesFact(view: SummaryView): string {
  if (view.checkpoint?.kind === 'rejected' && view.checkpoint.putBack !== undefined)
    return formatApplyRestoreCounts(view.checkpoint.putBack);
  const changed = view.files.changed;
  if (changed === null || changed.length === 0) return filesFact(view);
  if (view.files.patch !== null) return `${countNoun(changed.length, 'file')} saved in run.patch`;
  return filesFact(view);
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
  if (review.kind !== 'written') return secondaryFact(unwrittenReviewText(review));
  const findings = findingFacts(review.counts).join(', ');
  return review.verdict === 'fail'
    ? [
        ...secondaryFact('review '),
        { text: 'failed', tone: stateTone('failed') },
        ...(findings === '' ? [] : secondaryFact(` ${findings}`)),
      ]
    : secondaryFact(`review ${findings === '' ? 'no findings' : findings}`);
}

function scopeFact(scope: ScopeView): OutcomeSpan[] {
  if (scope.kind === 'not-run') return secondaryFact('scope not checked');
  const clean = scopeCleanSegment(scope);
  return clean === null
    ? secondaryFact(`scope ${countNoun(scope.errors + scope.warnings, 'deviation')}`)
    : [...secondaryFact('scope '), clean];
}
