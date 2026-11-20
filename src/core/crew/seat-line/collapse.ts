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

const SEPARATOR_CELLS = getTerminalCellWidth(CREW_IDENTITY_SEPARATOR);

/**
 * Every seat, whole, on at most `rows` rows of `budget` cells: each row takes the seats that fit
 * after the ones before it. `null` when a seat alone is wider than a row or the seats need more rows.
 */
export function packSeatRows(
  spans: readonly SeatLineSpan[],
  budget: number,
  rows: number,
): SeatLineSpan[][] | null {
  const packed: SeatLineSpan[][] = [];
  let row: SeatLineSpan[] = [];
  let cells = 0;
  for (const span of spans) {
    if (span.seat === undefined) continue;
    const width = getTerminalCellWidth(span.text);
    if (width > budget) return null;
    if (row.length > 0 && cells + SEPARATOR_CELLS + width <= budget) {
      row.push({ text: CREW_IDENTITY_SEPARATOR }, span);
      cells += SEPARATOR_CELLS + width;
      continue;
    }
    if (row.length > 0) packed.push(row);
    row = [span];
    cells = width;
  }
  if (row.length > 0) packed.push(row);
  return packed.length <= rows ? packed : null;
}

const withoutNotes = (seats: readonly CollapsedSeat[]): CollapsedSeat[] =>
  seats.map(({ id, identity }) => ({ id, identity }));

/**
 * The crew a budget can pay for, never a part of it: a seat left off a line reads as no seat at
 * all, and half a model name spells another model. The crew's own names go first and the tool
 * words after them, each with the notes the seats carry, then both again without the notes: a
 * clock beside a seat says what is happening right now, but never at the cost of a seat. A
 * budget that pays for none of them buys no line at all.
 */
function fitCollapsedSeatRows(
  seats: readonly CollapsedSeat[],
  toolSeats: readonly CollapsedSeat[],
  budget: number,
  rows: number,
): SeatLineSpan[][] {
  for (const candidate of [seats, toolSeats, withoutNotes(seats), withoutNotes(toolSeats)]) {
    const packed = packSeatRows(candidate.map(collapsedSeatText), budget, rows);
    if (packed !== null) return packed;
  }
  return [];
}

type SeatLineInput = Readonly<{
  planner: RunnerConfig | SeatIds;
  build: RunnerConfig | SeatIds;
  /** `undefined` is the planner's seat. */
  reviewer: RunnerConfig | SeatIds | typeof REVIEW_NONE | undefined;
  budget?: number | undefined;
  /** What each seat is carrying right now, e.g. the reset clock of a quota-blocked seat. */
  notes?: Partial<Record<CrewSeatId, string>> | undefined;
  /**
   * The line to lay out: the model names, or every seat by the tool word a narrow header has
   * room for. Left out, the line falls back to the tools when the names do not fit.
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
}>;

/** The crew on one line, or no line. */
export function formatCollapsedSeatSpans(input: SeatLineInput): SeatLineSpan[] {
  return formatCollapsedSeatRows({ ...input, rows: 1 })[0] ?? [];
}

/** The crew on at most `rows` rows, every seat whole, or no rows. */
export function formatCollapsedSeatRows(
  input: SeatLineInput & Readonly<{ rows: number }>,
): SeatLineSpan[][] {
  const reviewer = isReviewNone(input.reviewer) ? undefined : input.reviewer;
  const absentReview = isReviewNone(input.reviewer) ? REVIEW_NONE : null;
  if (input.line === 'tool') {
    return formatCollapsedSeatRowsFromIdentities({
      plan: formatSeatToolWord({ seat: input.planner }),
      build: formatSeatToolWord({ seat: input.build }),
      review: reviewer === undefined ? absentReview : formatSeatToolWord({ seat: reviewer }),
      budget: input.budget,
      notes: input.notes,
      rows: input.rows,
    });
  }
  const plannerName = input.displayNames?.planner ?? input.displayNames?.plan;
  const buildName = input.displayNames?.build;
  const reviewerName = input.displayNames?.reviewer ?? input.displayNames?.review ?? plannerName;
  const planWord = formatShortSeatIdentity({ seat: input.planner, displayName: plannerName });
  const buildWord = formatShortSeatIdentity({ seat: input.build, displayName: buildName });
  const reviewWord =
    reviewer === undefined
      ? absentReview
      : formatShortSeatIdentity({ seat: reviewer, displayName: reviewerName });
  if (input.line === 'model') {
    return formatCollapsedSeatRowsFromIdentities({
      plan: planWord,
      build: buildWord,
      review: reviewWord,
      budget: input.budget,
      notes: input.notes,
      rows: input.rows,
    });
  }
  const plannerTool = formatSeatToolWord({ seat: input.planner });
  const buildTool = formatSeatToolWord({ seat: input.build });
  const reviewerTool = reviewer === undefined ? undefined : formatSeatToolWord({ seat: reviewer });
  return formatCollapsedSeatRowsFromIdentities({
    plan: planWord,
    build: buildWord,
    review: reviewWord,
    tools: {
      plan: plannerTool,
      build: buildTool,
      ...(reviewerTool !== undefined && { review: reviewerTool }),
    },
    budget: input.budget,
    notes: input.notes,
    rows: input.rows,
  });
}

type SeatIdentitiesInput = Readonly<{
  plan: string;
  build: string;
  review: string | null | typeof REVIEW_NONE;
  tools?: Partial<Record<CrewSeatId, string>> | undefined;
  budget?: number | undefined;
  notes?: Partial<Record<CrewSeatId, string>> | undefined;
}>;

/**
 * The layout half: three identities already resolved, laid out on one line of a budget. A finished run has
 * names on record but no runner blocks, so this is the seam the summary header enters through.
 * A `null` review seat is the planner's, and says so with the inheritance mark. `REVIEW_NONE` is a
 * run with no review seat. `tools` carries
 * the command each seat takes on the tool line, which the line falls back to when the names do
 * not fit; a seat without one keeps its identity.
 */
export function formatCollapsedSeatSpansFromIdentities(input: SeatIdentitiesInput): SeatLineSpan[] {
  return formatCollapsedSeatRowsFromIdentities({ ...input, rows: 1 })[0] ?? [];
}

/** The layout half on at most `rows` rows, every seat whole, or no rows. */
export function formatCollapsedSeatRowsFromIdentities(
  input: SeatIdentitiesInput & Readonly<{ rows: number }>,
): SeatLineSpan[][] {
  const notes = input.notes;
  const seats: CollapsedSeat[] = [
    { id: 'plan', identity: input.plan, ...(notes?.plan !== undefined && { note: notes.plan }) },
    {
      id: 'build',
      identity: input.build,
      ...(notes?.build !== undefined && { note: notes.build }),
    },
    {
      id: 'review',
      identity:
        input.review === null
          ? PLANNER_INHERITANCE.mark
          : typeof input.review === 'string'
            ? input.review
            : input.review.mark,
      ...(notes?.review !== undefined && { note: notes.review }),
    },
  ];
  const toolSeats = seats.map((seat) => {
    const tool = input.tools?.[seat.id];
    return tool === undefined ? seat : { ...seat, identity: tool };
  });
  return fitCollapsedSeatRows(
    seats,
    toolSeats,
    input.budget ?? Number.POSITIVE_INFINITY,
    input.rows,
  );
}
