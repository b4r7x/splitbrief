import { CREW_SEAT_IDS, seatLineText, type SeatLineSpan } from '../../../core/crew/identity.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { getHeaderLayout } from '../components/header.js';
import { chooseFormBVariant, getChromeContentWidth, measureFormB } from '../layout/chrome-rows.js';
import { crewLine } from './copy.js';
import type { SummaryView } from './view-model.js';

export interface ClosedHeader {
  /** The crew that actually ran, fitted to the room the rail and the clock leave. */
  seatLine: readonly SeatLineSpan[];
  /** True when that line names all three seats, so the Run block does not name them again. */
  crewNamed: boolean;
}

/**
 * The header of a closed run names the crew that ran it, not the crew configured today. The room
 * does not depend on the line, so the first pass measures the rail, the line is cut to what is
 * left, and the second pass asks whether the whole crew survived the cut.
 */
export function closedHeader(input: Readonly<{ view: SummaryView; cols: number }>): ClosedHeader {
  const { view, cols } = input;
  const contentWidth = getChromeContentWidth(cols);
  const railCells = measureFormB(view.rail, chooseFormBVariant(view.rail, contentWidth));
  const seatLine = crewLine(view, getHeaderLayout({ cols, railCells }).seatRoom);
  const seatCells = getTerminalCellWidth(seatLineText(seatLine));
  const crewNamed =
    getHeaderLayout({ cols, railCells, seatCells }).showSeats && namesEverySeat(seatLine);
  return { seatLine, crewNamed };
}

/**
 * Whether a fitted seat line already names the whole crew. A seat the line could not afford leaves
 * it entirely, so this is what decides whether the Run block states the crew: one name, one home.
 * An inherited reviewer ends in `= PLAN`, but its span still belongs to the review seat.
 */
export function namesEverySeat(seatLine: readonly SeatLineSpan[]): boolean {
  return CREW_SEAT_IDS.every((seat) => seatLine.some((span) => span.seat === seat));
}
