import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { collapsedReviewSeat } from '../../../core/crew/seats.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { RunRecord } from '../../../core/sessions/run/record.js';
import { isReviewNone, type REVIEW_NONE, type CrewSeatId } from '../../../core/crew/identity.js';
import {
  formatCollapsedSeatSpans,
  type SeatLineSpan,
} from '../../../core/crew/seat-line/collapse.js';
import { idsOf, isSeatIdentity, type SeatIds } from '../../../core/crew/seat-ids.js';
import type { RunHalt } from '../../../core/run-view/halt.js';
import { formatResetNote } from '../../../core/recovery/reset-clock.js';
import type { RunningSeats } from './running-seats.js';
import { crewLine } from '../closed/copy.js';
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
  haltedSeat?: CrewSeatId | undefined;
}

export interface HeaderSeatLines {
  /** Every seat by the name the header shows while there is room. */
  model: readonly SeatLineSpan[];
  /** Every seat by the tool word a narrow header has room for. */
  tool: readonly SeatLineSpan[];
}

export interface DisplayedSeatLines extends HeaderSeatLines {
  /**
   * Today's seats, for the line the header elides when neither whole line fits. Null with no
   * config, and while the run on screen names its recorded crew: the screen passes that line.
   */
  todaySeats: HeaderSeats | null;
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
  const haltedSeat = halt?.issue.seat;
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
    ...(haltedSeat !== undefined && { haltedSeat }),
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
    model: crewLine({ seats }, Number.POSITIVE_INFINITY, { line: 'model' }),
    tool: crewLine({ seats }, Number.POSITIVE_INFINITY, { line: 'tool' }),
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
): DisplayedSeatLines {
  const recorded = record === undefined ? null : recordedCrew(record);
  if (recorded !== null) return { ...recordedCrewSeatLines(recorded), todaySeats: null };
  return todaySeats === null
    ? { model: [], tool: [], todaySeats }
    : { ...headerSeatLines(todaySeats), todaySeats };
}
