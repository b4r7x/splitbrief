import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { getChromeContentWidth, selectRailFormAndLine } from '../layout/chrome-rows.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { collapsedReviewSeat } from '../../../core/crew/seats.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { RunRecord } from '../../../core/sessions/run/record.js';
import { isReviewNone, type REVIEW_NONE, type CrewSeatId } from '../../../core/crew/identity.js';
import {
  formatCollapsedSeatSpans,
  packSeatRows,
  seatLineText,
  type SeatLineSpan,
} from '../../../core/crew/seat-line/collapse.js';
import { idsOf, isSeatIdentity, type SeatIds } from '../../../core/crew/seat-ids.js';
import type { RunHalt } from '../../../core/run-view/halt.js';
import { formatResetNote } from '../../../core/recovery/reset-clock.js';
import type { RunningSeats } from './running-seats.js';
import { crewLine } from '../closed/copy/crew-line.js';
import { recordedCrew, type RecordedCrew } from '../closed/view-model.js';

export interface HeaderSeats {
  planner: RunnerConfig | SeatIds;
  build: RunnerConfig | SeatIds;
  reviewer: RunnerConfig | SeatIds | typeof REVIEW_NONE | undefined;
  displayNames: Readonly<{
    planner?: string | undefined;
    plan?: string | undefined;
    build?: string | undefined;
    reviewer?: string | undefined;
    review?: string | undefined;
  }>;
  notes?: Partial<Record<CrewSeatId, string>> | undefined;
}

export interface HeaderSeatLines {
  /** Every seat by the name the header shows while there is room. */
  model: readonly SeatLineSpan[];
  /** Every seat by the tool word a narrow header has room for. */
  tool: readonly SeatLineSpan[];
}

/**
 * A halt annotates its own seat, only while it names both the seat and a reset, and only
 * while that seat shows the tool and model the halted call ran on: a seat saved since, or the
 * default BUILD seat beside a named profile that halted, has no limit to wait for.
 */
function seatResetNotes(
  halt: RunHalt | null,
  ranOn: SeatIds | null,
  shown: Readonly<Record<CrewSeatId, SeatIds>>,
): Partial<Record<CrewSeatId, string>> | undefined {
  const seat = halt?.issue.seat;
  const resetAt = Date.parse(halt?.issue.resetAt ?? '');
  if (seat === undefined || ranOn === null || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const onScreen = shown[seat];
  if (!isSeatIdentity(onScreen, ranOn) && !isSeatIdentity(ranOn, onScreen)) return undefined;
  return { [seat]: formatResetNote(resetAt) };
}

/**
 * The seats configured today, as the header names a run that carries no recorded crew of its own:
 * the seat a call runs on stands over the saved one.
 */
export function headerSeats(
  input: Readonly<{
    config: Config | null;
    running: RunningSeats;
    displayNames: Partial<Record<CrewSeatId, string>>;
    halt: RunHalt | null;
    ranOn: SeatIds | null;
  }>,
): HeaderSeats | null {
  const { config, running, displayNames, halt, ranOn } = input;
  if (!config) return null;
  const planDisplay = running.plan !== undefined ? running.plan.displayName : displayNames.plan;
  const buildDisplay = running.build !== undefined ? running.build.displayName : displayNames.build;
  const reviewDisplay =
    running.review !== undefined ? running.review.displayName : displayNames.review;
  const seats = {
    planner: running.plan?.seat ?? config.planner,
    build: running.build?.seat ?? resolveImplementerProfiles(config).defaultProfile.config,
    reviewer: running.review?.seat ?? collapsedReviewSeat(config),
  };
  const notes = seatResetNotes(halt, ranOn, {
    plan: idsOf(seats.planner),
    build: idsOf(seats.build),
    review: idsOf(
      seats.reviewer === undefined || isReviewNone(seats.reviewer) ? seats.planner : seats.reviewer,
    ),
  });
  return {
    ...seats,
    displayNames: {
      ...(planDisplay !== undefined && { planner: planDisplay, plan: planDisplay }),
      ...(buildDisplay !== undefined && { build: buildDisplay }),
      ...(reviewDisplay !== undefined && { reviewer: reviewDisplay, review: reviewDisplay }),
    },
    ...(notes !== undefined && { notes }),
  };
}

/** The two whole crew lines a header can name beside its rail. */
function headerSeatLines(seats: HeaderSeats): HeaderSeatLines {
  return {
    model: formatCollapsedSeatSpans({ ...seats, line: 'model' }),
    tool: formatCollapsedSeatSpans({ ...seats, line: 'tool' }),
  };
}

/** The two whole crew lines one recorded crew names, in the words the header lays out. */
export function recordedCrewSeatLines(seats: RecordedCrew): HeaderSeatLines {
  return {
    model: crewLine({ seats }, Number.POSITIVE_INFINITY, 'model'),
    tool: crewLine({ seats }, Number.POSITIVE_INFINITY, 'tool'),
  };
}

/**
 * The two whole crew lines the header lays its rail beside: the recorded crew's while the run on
 * screen names one, today's otherwise. The screen, the header and the click-zone snapshot read
 * this one answer, so the rail they choose is the rail the crew on display fits beside.
 */
export function displayedSeatLines(
  record: RunRecord | undefined,
  todaySeats: HeaderSeats | null,
): HeaderSeatLines {
  const recorded = record === undefined ? null : recordedCrew(record);
  if (recorded !== null) return recordedCrewSeatLines(recorded);
  return todaySeats === null ? { model: [], tool: [] } : headerSeatLines(todaySeats);
}

/** A closed run can name its crew in its summary. An open run reserves whole rows when even
 * the single-stage rail cannot share a row with all three seats. */
export function wrappedHeaderCrew(
  cols: number,
  singleStageCells: number,
  lines: HeaderSeatLines,
  closed: boolean,
): SeatLineSpan[][] {
  if (closed || lines.tool.length === 0) return [];
  const choice = selectRailFormAndLine({
    cols,
    railWidths: { C: singleStageCells },
    modelLineCells: getTerminalCellWidth(seatLineText(lines.model)),
    toolLineCells: getTerminalCellWidth(seatLineText(lines.tool)),
  });
  return choice.line === 'none'
    ? (packSeatRows(lines.tool, getChromeContentWidth(cols), 3) ?? [])
    : [];
}
