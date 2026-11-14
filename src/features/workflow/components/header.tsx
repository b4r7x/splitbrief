import { ThemeText as Text } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { formatCollapsedSeatSpans, seatLineText } from '../../../core/crew/seat-line/collapse.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { SeatLineSpan } from '../../../core/crew/seat-line/collapse.js';
import type { RailStageState } from '../../../core/phases/rail.js';
import {
  getChromeContentWidth,
  HEADER_RAIL_SEAT_GAP,
  selectRailFormAndLine,
  type RailForm,
} from '../layout/chrome-rows.js';
import { Rail } from './rail.js';
import { useRailCells } from '../hooks/use-rail-cells.js';
import { useHeaderSeatLines } from '../hooks/use-header-seat-lines.js';

interface HeaderProps {
  railForm?: RailForm | undefined;
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
    C: useRailCells({ form: 'C', buildBlockShown, ...(stages !== undefined && { stages }) }),
  };
  const choice = selectRailFormAndLine({
    cols,
    railWidths:
      railForm === undefined
        ? railWidths
        : railForm === 'B'
          ? { B: railWidths.B, BShort: railWidths.BShort }
          : { C: railWidths.C },
    modelLineCells: getTerminalCellWidth(seatLineText(lines.model)),
    toolLineCells: getTerminalCellWidth(seatLineText(lines.tool)),
  });
  const form = railForm ?? choice.form;
  const railCells = form === 'C' ? railWidths.C : choice.short ? railWidths.BShort : railWidths.B;
  // The choice already paid for a whole line; only the elided line spends the seat room again.
  const { seatRoom } = getHeaderLayout({ cols, railCells });
  const seats = lines.todaySeats;
  const liveSeatLine =
    choice.line !== 'elided'
      ? lines[choice.line]
      : seats === null
        ? []
        : formatCollapsedSeatSpans({ ...seats, budget: seatRoom });
  const seatLine = givenSeatLine ?? liveSeatLine;
  return (
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
            <TextSpans
              parts={seatLine.map((span) => ({
                text: span.text,
                tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
              }))}
            />
          </Text>
        </Box>
      )}
    </Box>
  );
}
