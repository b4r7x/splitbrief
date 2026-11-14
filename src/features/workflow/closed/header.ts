import { CREW_SEAT_IDS } from '../../../core/crew/identity.js';
import { seatLineText, type SeatLineSpan } from '../../../core/crew/seat-line/collapse.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { getHeaderLayout } from '../components/header.js';
import { recordedCrewSeatLines } from '../display/header-seat-lines.js';
import { selectRailFormAndLine, type RailForm } from '../layout/chrome-rows.js';
import type { RunRecord } from '../../../core/sessions/run/record.js';
import { crewLine } from './copy.js';
import { recordedCrew, type RecordedCrew } from './view-model.js';

export interface RecordedCrewHeader {
  /** The crew that built the run, as its record names it. */
  seats: RecordedCrew;
  /** That crew, fitted to the room the rail leaves. */
  seatLine: readonly SeatLineSpan[];
  /** True when the header chose the whole model line, so the Run block does not name the crew again. */
  crewNamed: boolean;
}

/**
 * The header of a run that names its recorded crew (`recordedCrew`) names that crew, not the crew
 * configured today; null for a run that names today's crew. The screen owns the rail form and its
 * label variant, so this offers only the rail the screen paints, measured at its actual width, to
 * the joint selector and takes the line that choice names: the model words, the tool words, or an
 * elided line beside the same rail. A line that only names the crew by its tool words still leaves
 * the Run block to state the names.
 */
export function recordedCrewHeader(
  input: Readonly<{
    record: RunRecord;
    form: RailForm;
    short: boolean;
    railCells: number;
    cols: number;
  }>,
): RecordedCrewHeader | null {
  const { record, form, short, railCells, cols } = input;
  const seats = recordedCrew(record);
  if (seats === null) return null;
  const { model: modelLine, tool: toolLine } = recordedCrewSeatLines(seats);
  const choice = selectRailFormAndLine({
    cols,
    railWidths: form === 'C' ? { C: railCells } : short ? { BShort: railCells } : { B: railCells },
    modelLineCells: getTerminalCellWidth(seatLineText(modelLine)),
    toolLineCells: getTerminalCellWidth(seatLineText(toolLine)),
  });
  const { seatRoom } = getHeaderLayout({ cols, railCells });
  const seatLine =
    choice.line === 'model'
      ? modelLine
      : choice.line === 'tool'
        ? toolLine
        : crewLine({ seats }, seatRoom);
  return { seats, seatLine, crewNamed: choice.line === 'model' && namesEverySeat(seatLine) };
}

/**
 * Whether a fitted seat line names the whole crew: a seat the line could not afford leaves it
 * entirely. An inherited reviewer ends in `= PLAN`, but its span still belongs to the review seat.
 */
export function namesEverySeat(seatLine: readonly SeatLineSpan[]): boolean {
  return CREW_SEAT_IDS.every((seat) => seatLine.some((span) => span.seat === seat));
}
