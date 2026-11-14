import { REVIEW_NONE, PLANNER_INHERITANCE } from '../../../../core/crew/identity.js';
import {
  type SeatLineSpan,
  formatCollapsedSeatSpansFromIdentities,
} from '../../../../core/crew/seat-line/collapse.js';
import { arrowSep } from '../../../../core/separators.js';
import { countNoun } from '../../../../utils/pluralize.js';
import type { SummaryView, SeatView } from '../view-model.js';

/**
 * The crew line the header would paint, laid out to whatever the Run block can spare. The summary
 * has names on record rather than runner blocks, so it enters the layout half directly. A budget
 * that cannot seat every name falls back to the tool words; `line` lays out that one line alone.
 */
export function crewLine(
  view: Pick<SummaryView, 'seats'>,
  budget: number,
  options: Readonly<{ line?: 'model' | 'tool' | undefined }> = {},
): readonly SeatLineSpan[] {
  const review = view.seats.review;
  const toolLine = options.line === 'tool';
  const word = (seat: SeatView): string =>
    toolLine ? (seatToolWord(seat) ?? seatWord(seat)) : seatWord(seat);
  const planTool = seatToolWord(view.seats.plan);
  const buildTool = seatToolWord(view.seats.build);
  const reviewTool = seatToolWord(review);
  return formatCollapsedSeatSpansFromIdentities({
    plan: word(view.seats.plan),
    build: word(view.seats.build),
    review: review.kind === 'inherits' ? null : review.kind === 'none' ? REVIEW_NONE : word(review),
    ...(options.line === undefined && {
      tools: {
        ...(planTool !== undefined && { plan: planTool }),
        ...(buildTool !== undefined && { build: buildTool }),
        ...(reviewTool !== undefined && { review: reviewTool }),
      },
    }),
    budget,
  });
}

/** The command a named seat takes when the line is laid out by tool words. */
function seatToolWord(seat: SeatView): string | undefined {
  return seat.kind === 'named' ? seat.tool : undefined;
}

/**
 * A seat as the sidebar crew names it, in the pieces a narrow row breaks between: a named seat
 * with its tool, like the live crew rows; a move after each arrow; a back-and-forth after each comma.
 */
export function seatIdentityPieces(seat: SeatView): string[] {
  switch (seat.kind) {
    case 'named':
      return [seat.full];
    case 'moved':
      return movedPieces(seat);
    default:
      return [seatWord(seat)];
  }
}

// A seat that left one tool for good reads as the move; one that went back and forth has no
// single move to name, so it says how much each tool did.
function movedPieces(seat: Extract<SeatView, { kind: 'moved' }>): string[] {
  const last = seat.seats.length - 1;
  if (seat.contiguous) {
    const arrow = arrowSep().trimEnd();
    return seat.seats.map((moved, index) =>
      index < last ? `${moved.short}${arrow}` : moved.short,
    );
  }
  return seat.seats.map((moved, index) => {
    const share =
      index === 0
        ? `${countNoun(moved.briefs, 'brief')} on ${moved.short}`
        : `${moved.briefs} on ${moved.short}`;
    return index < last ? `${share},` : share;
  });
}

function seatWord(seat: SeatView): string {
  switch (seat.kind) {
    case 'named':
      return seat.short;
    case 'mixed':
      return seat.profiles.length === 0
        ? 'mixed workers'
        : `mixed workers (${seat.profiles.join(', ')})`;
    case 'moved':
      return movedPieces(seat).join(' ');
    case 'inherits':
      return PLANNER_INHERITANCE.mark;
    case 'none':
      return REVIEW_NONE.mark;
    default:
      return 'not recorded';
  }
}
