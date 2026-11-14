import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import type { RunnerConfig } from '../../config/accessors/runner-config.js';
import {
  type CrewSeatId,
  CREW_SEAT_LABELS,
  CREW_IDENTITY_SEPARATOR,
  REVIEW_NONE,
  formatShortSeatIdentity,
  isReviewNone,
  formatSeatToolWord,
  PLANNER_INHERITANCE,
} from '../identity.js';
import type { SeatIds } from '../seat-ids.js';

export type SeatLineSpan = Readonly<{ text: string; seat?: CrewSeatId }>;

type CollapsedSeat = Readonly<{
  id: CrewSeatId;
  identity: string;
  named: boolean;
  /** A condition the seat carries while it lasts, parenthesized so it binds to this seat and not the next. */
  note?: string | undefined;
}>;

function collapsedSeatText(seat: CollapsedSeat): SeatLineSpan {
  const label = CREW_SEAT_LABELS[seat.id];
  const text =
    seat.note === undefined
      ? `${label} ${seat.identity}`
      : `${label} ${seat.identity} (${seat.note})`;
  return { text, seat: seat.id };
}

export function seatLineText(spans: readonly SeatLineSpan[]): string {
  return spans.map((span) => span.text).join('');
}

// An elided seat leaves the line entirely. `REVIEW …` names no seat and reads as "pending" beside
// the workflow rail, so the seats that still fit are stated and the rest are silent.
function collapsedSeatLine(
  seats: readonly Readonly<{ span: SeatLineSpan }>[],
  elided: ReadonlySet<number>,
): SeatLineSpan[] {
  const spans: SeatLineSpan[] = [];
  for (const [index, seat] of seats.entries()) {
    if (elided.has(index)) continue;
    if (spans.length > 0) spans.push({ text: CREW_IDENTITY_SEPARATOR });
    spans.push(seat.span);
  }
  return spans;
}

/**
 * A seat that overruns the line loses its whole identity: half a model name
 * spells another model. The line hides the fewest names it can, and when more
 * than one name would buy the fit it spends the seat furthest along the line —
 * the planner leads and is the last to go anonymous — so which seat is named
 * does not change as the terminal is dragged a column. A budget that leaves no
 * name standing buys no line at all: labels and ellipses state nothing, and
 * beside the workflow rail an ellipsis already reads as "pending".
 */
function elideCollapsedSeats(
  seats: readonly (CollapsedSeat & Readonly<{ span: SeatLineSpan }>)[],
  budget: number,
  haltedSeat?: CrewSeatId,
): SeatLineSpan[] {
  const lastFirst = seats
    .map((seat, index) => ({ index, width: getTerminalCellWidth(seat.identity) }))
    .reverse();
  const elided = new Set<number>();
  const width = (omitted: ReadonlySet<number>): number =>
    getTerminalCellWidth(seatLineText(collapsedSeatLine(seats, omitted)));
  const fitsWithout = (index: number): boolean => width(new Set([...elided, index])) <= budget;
  while (elided.size < seats.length && width(elided) > budget) {
    const remaining = lastFirst.filter((seat) => !elided.has(seat.index));
    const pool = remaining.filter(
      (seat) => seats[seat.index]?.note === undefined && seats[seat.index]?.id !== haltedSeat,
    );
    if (pool.length === 0) return [];
    // When no single name is enough, the widest goes and the line is measured
    // again, so the line never hides more names than it has to.
    const chosen =
      pool.find((seat) => fitsWithout(seat.index)) ??
      pool.reduce((widest, seat) => (seat.width > widest.width ? seat : widest));
    elided.add(chosen.index);
  }
  const namesSomeone = seats.some((seat, index) => seat.named && !elided.has(index));
  return namesSomeone ? collapsedSeatLine(seats, elided) : [];
}

/** Every seat on one line, with whatever note each carries. */
function wholeSeatLine(seats: readonly CollapsedSeat[]): SeatLineSpan[] {
  return collapsedSeatLine(
    seats.map((seat) => ({ ...seat, span: collapsedSeatText(seat) })),
    new Set(),
  );
}

/**
 * The line a budget can pay for. The crew's own names go first; when they do not fit, the tool
 * line can still name every seat, and only when neither fits does the line give a seat up.
 * A note rides its seat on the tool line as it does on the named one.
 *
 * On the elided line a note outranks the names of the seats it does not belong to: it says what
 * is happening right now, and the elision rule already spends those names to buy room. What it
 * never outranks is its own seat's name — a clock beside `BUILD …` names no seat — so a budget
 * that cannot seat the noted name drops every note and lays the plain line out. The halted seat
 * stays protected while the plain line names a seat.
 */
function fitCollapsedSeats(
  seats: readonly CollapsedSeat[],
  toolSeats: readonly CollapsedSeat[],
  budget: number,
  haltedSeat?: CrewSeatId,
): SeatLineSpan[] {
  const modelled = wholeSeatLine(seats);
  if (getTerminalCellWidth(seatLineText(modelled)) <= budget) return modelled;
  const tools = wholeSeatLine(toolSeats);
  if (getTerminalCellWidth(seatLineText(tools)) <= budget) return tools;
  const notedSeats = seats.map((seat) => ({ ...seat, span: collapsedSeatText(seat) }));
  const plainSeats = notedSeats.map((seat) => {
    if (seat.note === undefined) return seat;
    const plain = { id: seat.id, identity: seat.identity, named: seat.named };
    return { ...plain, span: collapsedSeatText(plain) };
  });
  const protectedSeat =
    haltedSeat !== undefined && elideCollapsedSeats(plainSeats, budget, haltedSeat).length > 0
      ? haltedSeat
      : undefined;
  const noted = elideCollapsedSeats(notedSeats, budget, protectedSeat);
  if (seats.every((seat) => seat.note === undefined)) return noted;
  if (noted.length > 0 && getTerminalCellWidth(seatLineText(noted)) <= budget) return noted;
  return elideCollapsedSeats(plainSeats, budget, protectedSeat);
}

export function formatCollapsedSeatSpans(
  input: Readonly<{
    planner: RunnerConfig | SeatIds;
    build: RunnerConfig | SeatIds;
    /** `undefined` is the planner's seat. */
    reviewer: RunnerConfig | SeatIds | typeof REVIEW_NONE | undefined;
    budget?: number | undefined;
    haltedSeat?: CrewSeatId | undefined;
    /** What each seat is carrying right now, e.g. the reset clock of a quota-blocked seat. */
    notes?: Partial<Record<CrewSeatId, string>> | undefined;
    /**
     * The line to lay out: the model names, or every seat by the tool word a narrow header has
     * room for. Left out, the line falls back to the tools before it elides a seat.
     */
    line?: 'model' | 'tool' | undefined;
    displayNames?:
      | Readonly<{
          planner?: string | undefined;
          build?: string | undefined;
          reviewer?: string | undefined;
          plan?: string | undefined;
          review?: string | undefined;
        }>
      | undefined;
  }>,
): SeatLineSpan[] {
  const plannerName = input.displayNames?.planner ?? input.displayNames?.plan;
  const buildName = input.displayNames?.build;
  const reviewerName = input.displayNames?.reviewer ?? input.displayNames?.review ?? plannerName;
  const planWord = formatShortSeatIdentity({ seat: input.planner, displayName: plannerName });
  const buildWord = formatShortSeatIdentity({ seat: input.build, displayName: buildName });
  const reviewer = isReviewNone(input.reviewer) ? undefined : input.reviewer;
  const absentReview = isReviewNone(input.reviewer) ? REVIEW_NONE : null;
  const reviewWord =
    reviewer === undefined
      ? absentReview
      : formatShortSeatIdentity({ seat: reviewer, displayName: reviewerName });
  if (input.line === 'tool') {
    return formatCollapsedSeatSpansFromIdentities({
      plan: formatSeatToolWord({ seat: input.planner }),
      build: formatSeatToolWord({ seat: input.build }),
      review: reviewer === undefined ? absentReview : formatSeatToolWord({ seat: reviewer }),
      budget: input.budget,
      haltedSeat: input.haltedSeat,
      notes: input.notes,
    });
  }
  if (input.line === 'model') {
    return formatCollapsedSeatSpansFromIdentities({
      plan: planWord,
      build: buildWord,
      review: reviewWord,
      budget: input.budget,
      haltedSeat: input.haltedSeat,
      notes: input.notes,
    });
  }
  const plannerTool = formatSeatToolWord({ seat: input.planner });
  const buildTool = formatSeatToolWord({ seat: input.build });
  const reviewerTool = reviewer === undefined ? undefined : formatSeatToolWord({ seat: reviewer });
  return formatCollapsedSeatSpansFromIdentities({
    plan: planWord,
    build: buildWord,
    review: reviewWord,
    tools: {
      plan: plannerTool,
      build: buildTool,
      ...(reviewerTool !== undefined && { review: reviewerTool }),
    },
    budget: input.budget,
    haltedSeat: input.haltedSeat,
    notes: input.notes,
  });
}

/**
 * The layout half: three identities already resolved, laid out to a budget. A finished run has
 * names on record but no runner blocks, so this is the seam the summary header enters through.
 * A `null` review seat is the planner's, and says so with the inheritance mark. `REVIEW_NONE` is a
 * run with no review seat. `tools` carries
 * the command each seat takes on the tool line, which the line falls back to when the names do
 * not fit; a seat without one keeps its identity.
 */
export function formatCollapsedSeatSpansFromIdentities(
  input: Readonly<{
    plan: string;
    build: string;
    review: string | null | typeof REVIEW_NONE;
    tools?: Partial<Record<CrewSeatId, string>> | undefined;
    budget?: number | undefined;
    haltedSeat?: CrewSeatId | undefined;
    notes?: Partial<Record<CrewSeatId, string>> | undefined;
  }>,
): SeatLineSpan[] {
  const notes = input.notes;
  const seats: CollapsedSeat[] = [
    {
      id: 'plan',
      identity: input.plan,
      named: true,
      ...(notes?.plan !== undefined && { note: notes.plan }),
    },
    {
      id: 'build',
      identity: input.build,
      named: true,
      ...(notes?.build !== undefined && { note: notes.build }),
    },
    // The inheritance mark points at the planner's name; it is not one itself.
    {
      id: 'review',
      identity:
        input.review === null
          ? PLANNER_INHERITANCE.mark
          : typeof input.review === 'string'
            ? input.review
            : input.review.mark,
      named: typeof input.review === 'string',
      ...(notes?.review !== undefined && { note: notes.review }),
    },
  ];
  const toolSeats = seats.map((seat) => {
    const tool = input.tools?.[seat.id];
    return tool === undefined ? seat : { ...seat, identity: tool };
  });
  return fitCollapsedSeats(
    seats,
    toolSeats,
    input.budget ?? Number.POSITIVE_INFINITY,
    input.haltedSeat,
  );
}
