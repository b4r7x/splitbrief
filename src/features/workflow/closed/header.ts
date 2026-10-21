import { CREW_SEAT_IDS, seatLineText, type SeatLineSpan } from '../../../core/crew/identity.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { getHeaderLayout } from '../components/header.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { crewLine } from './copy.js';
import { recordedCrew, type RecordedCrew } from './view-model.js';

export interface RecordedCrewHeader {
  /** The crew that built the run, as its record names it. */
  seats: RecordedCrew;
  /** That crew, fitted to the room the rail leaves. */
  seatLine: readonly SeatLineSpan[];
  /** True when that line names all three seats, so the Run block does not name them again. */
  crewNamed: boolean;
}

/**
 * The header of a run that names its recorded crew (`recordedCrew`) names that crew, not the crew
 * configured today; null for a run that names today's crew. The room does not depend on the line,
 * so the line is cut to what the painted rail (`railCells`) leaves, and the second pass asks
 * whether the whole crew survived the cut.
 */
export function recordedCrewHeader(
  input: Readonly<{ record: RunRecord; railCells: number; cols: number }>,
): RecordedCrewHeader | null {
  const { record, railCells, cols } = input;
  const seats = recordedCrew(record);
  if (seats === null) return null;
  const seatLine = crewLine({ seats }, getHeaderLayout({ cols, railCells }).seatRoom);
  const seatCells = getTerminalCellWidth(seatLineText(seatLine));
  const crewNamed =
    getHeaderLayout({ cols, railCells, seatCells }).showSeats && namesEverySeat(seatLine);
  return { seats, seatLine, crewNamed };
}

/**
 * Whether a fitted seat line already names the whole crew. A seat the line could not afford leaves
 * it entirely, so this is what decides whether the Run block states the crew: one name, one home.
 * An inherited reviewer ends in `= PLAN`, but its span still belongs to the review seat.
 */
export function namesEverySeat(seatLine: readonly SeatLineSpan[]): boolean {
  return CREW_SEAT_IDS.every((seat) => seatLine.some((span) => span.seat === seat));
}
