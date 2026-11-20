import { ThemeText as Text } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { seatLineText } from '../../../core/crew/seat-line/collapse.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { SeatLineSpan } from '../../../core/crew/seat-line/collapse.js';
import type { RailStageState } from '../../../core/phases/rail.js';
import {
  getChromeContentWidth,
  HEADER_RAIL_SEAT_GAP,
  selectRailFormAndLine,
  railVariant,
  type RailForm,
} from '../layout/chrome-rows.js';
import { wrappedHeaderCrew } from '../display/header-seat-lines.js';
import { Rail } from './rail.js';
import { useRailCells } from '../hooks/use-rail-cells.js';
import { useHeaderSeatLines } from '../hooks/use-header-seat-lines.js';

interface HeaderProps {
  railForm?: RailForm | undefined;
  crewRows?: readonly (readonly SeatLineSpan[])[] | undefined;
  buildBlockShown?: boolean | undefined;
  /** A run at rest names the stages its own record earned, and the crew that actually ran it. */
  stages?: readonly RailStageState[] | undefined;
  seatLine?: readonly SeatLineSpan[] | undefined;
}

export interface HeaderLayout {
  contentWidth: number;
  railWidth: number;
  /** The cells left for the seat line once the rail is paid for. */
  seatRoom: number;
  showSeats: boolean;
}

export function getHeaderLayout(input: {
  cols: number;
  railCells: number;
  seatCells?: number | undefined;
}): HeaderLayout {
  const { cols, railCells, seatCells = 0 } = input;
  const contentWidth = getChromeContentWidth(cols);
  const minRail = Math.min(contentWidth, Math.max(0, railCells));
  const seatRoom = contentWidth - minRail - HEADER_RAIL_SEAT_GAP;
  const showSeats = seatCells > 0 && seatRoom >= seatCells;
  const railWidth = showSeats ? contentWidth - seatCells - HEADER_RAIL_SEAT_GAP : contentWidth;
  return { contentWidth, railWidth, seatRoom, showSeats };
}

export function Header({
  railForm,
  buildBlockShown = false,
  stages,
  seatLine: givenSeatLine,
  crewRows: reservedCrewRows,
}: HeaderProps) {
  const cols = terminalSizeStore.use((s) => s.cols);
  const lines = useHeaderSeatLines();
  const railWidths = {
    B: useRailCells({
      form: 'B',
      short: false,
      buildBlockShown,
      ...(stages !== undefined && { stages }),
    }),
    BShort: useRailCells({
      form: 'B',
      short: true,
      buildBlockShown,
      ...(stages !== undefined && { stages }),
    }),
    C: useRailCells({ form: 'C', buildBlockShown, stages }),
    CShort: useRailCells({ form: 'C', short: true, buildBlockShown, stages }),
  };
  const choice = selectRailFormAndLine({
    cols,
    railWidths:
      railForm === undefined
        ? railWidths
        : railForm === 'B'
          ? { B: railWidths.B, BShort: railWidths.BShort }
          : { C: railWidths.C, CShort: railWidths.CShort },
    modelLineCells: getTerminalCellWidth(seatLineText(lines.model)),
    toolLineCells: getTerminalCellWidth(seatLineText(lines.tool)),
  });
  const form = railForm ?? choice.form;
  const railCells = railWidths[railVariant(form, choice.short)];
  const liveSeatLine = choice.line === 'none' ? [] : lines[choice.line];
  const crewRows = reservedCrewRows ?? wrappedHeaderCrew(cols, railWidths.CShort, lines, false);
  const seatLine = crewRows.length > 0 ? [] : (givenSeatLine ?? liveSeatLine);
  return (
    <Box flexDirection="column">
      <HeaderRow
        cols={cols}
        railCells={railCells}
        seatLine={seatLine}
        rail={
          <Rail
            form={form}
            short={choice.short}
            buildBlockShown={buildBlockShown}
            {...(stages !== undefined && { stages })}
          />
        }
      />
      {crewRows.map((row) => (
        <Text key={seatLineText(row)}>
          <SeatWords spans={row} />
        </Text>
      ))}
    </Box>
  );
}

function SeatWords({ spans }: { spans: readonly SeatLineSpan[] }) {
  return (
    <TextSpans
      parts={spans.map((span) => ({
        text: span.text,
        tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
      }))}
    />
  );
}

/**
 * The header bar itself: rail on the left, the seat line pinned right, both paid for out of one
 * budget. It reads no store: the caller passes the rail and the seat line.
 */
function HeaderRow({
  rail,
  railCells,
  seatLine,
  cols,
}: {
  rail: ReactNode;
  railCells: number;
  seatLine: readonly SeatLineSpan[];
  cols: number;
}) {
  const layout = getHeaderLayout({
    cols,
    railCells,
    seatCells: getTerminalCellWidth(seatLineText(seatLine)),
  });
  return (
    <Box width="100%" height={1} overflow="hidden">
      <Box width={layout.railWidth} overflow="hidden">
        {rail}
      </Box>
      <Box flexGrow={1} />
      {layout.showSeats && (
        <Box flexShrink={0}>
          <Text>
            <SeatWords spans={seatLine} />
          </Text>
        </Box>
      )}
    </Box>
  );
}
