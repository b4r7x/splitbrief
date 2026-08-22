import { Fragment } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../components/theme.js';
import { crossLabVerdict, resolveLab, type CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewEscalateEntry, CrewSeat, CrewSeatId } from '../../core/crew/seats.js';
import { glyph } from '../../lib/glyphs.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import { assertNever } from '../../utils/type-guards.js';
import {
  CREW_COLUMN_GAP,
  CREW_MARKER_GUTTER,
  formatCrewEscalateRow,
  formatCrewSeatRow,
  type CrewRow,
} from './format.js';

const SPINE_INDENT = ' '.repeat(CREW_MARKER_GUTTER + 1 + CREW_COLUMN_GAP.length);
const BRANCH_LEAD = `${glyph('treeBranch')}${glyph('divider')} `;

const VERDICT_WORDS: Readonly<Record<CrewLabVerdict, string>> = {
  'cross-lab': 'reads the diff from another lab',
  'same-lab': 'same lab as the build',
};

function seatColor(theme: Theme, id: CrewSeatId): string {
  switch (id) {
    case 'plan':
      return theme.planner;
    case 'build':
      return theme.implementer;
    case 'review':
      return theme.reviewer;
    default:
      return assertNever(id);
  }
}

function verdictOf(seats: readonly CrewSeat[]): CrewLabVerdict | undefined {
  const build = seats.find((seat) => seat.id === 'build');
  const review = seats.find((seat) => seat.id === 'review');
  if (build === undefined || review === undefined) return undefined;
  return crossLabVerdict({
    build: resolveLab(build.runner),
    review: resolveLab(review.runner),
  });
}

/** The terminal rows the seat block occupies, so a page framing it can size its own chrome. */
export function crewSeatBlockRows(seats: readonly CrewSeat[]): number {
  return (
    seats.length * 2 -
    1 +
    seats.filter((seat) => seat.id === 'build' && seat.escalate !== undefined).length +
    (verdictOf(seats) === undefined ? 0 : 1)
  );
}

type SeatRowProps = Readonly<{ row: CrewRow; color: string; selected: boolean }>;

function SeatRow({ row, color, selected }: SeatRowProps) {
  const t = useTheme();
  return (
    <Box>
      <Text color={color}>
        {selected ? `${glyph('promptMarker')} ` : ' '.repeat(CREW_MARKER_GUTTER)}
      </Text>
      <Text color={color}>{row.index}</Text>
      <Text color={color} bold>{`${CREW_COLUMN_GAP}${row.label}`}</Text>
      <Text color={t.text}>{`${CREW_COLUMN_GAP}${row.identity}`}</Text>
      {row.posture !== undefined && (
        <Text color={t.textDim}>{`${CREW_COLUMN_GAP}${row.posture}`}</Text>
      )}
    </Box>
  );
}

type EscalateRowProps = Readonly<{ escalate: CrewEscalateEntry; width: number }>;

function EscalateRow({ escalate, width }: EscalateRowProps) {
  const t = useTheme();
  const row = formatCrewEscalateRow({
    escalate,
    width: width - SPINE_INDENT.length - BRANCH_LEAD.length,
  });
  return (
    <Box>
      <Text color={t.border}>{`${SPINE_INDENT}${BRANCH_LEAD}`}</Text>
      <Text color={t.implementer}>{row.label}</Text>
      <Text color={t.text}>{`${CREW_COLUMN_GAP}${row.identity}`}</Text>
      {row.posture !== undefined && (
        <Text color={t.textDim}>{`${CREW_COLUMN_GAP}${row.posture}`}</Text>
      )}
    </Box>
  );
}

export type SeatRowsProps = Readonly<{
  seats: readonly CrewSeat[];
  selected: CrewSeatId | undefined;
  width: number;
}>;

export function SeatRows({ seats, selected, width }: SeatRowsProps) {
  const t = useTheme();
  const verdict = verdictOf(seats);

  return (
    <Box flexDirection="column">
      {seats.map((seat, position) => {
        const row = formatCrewSeatRow({
          seat,
          position: position + 1,
          width: width - CREW_MARKER_GUTTER,
        });
        // The verdict hangs under the identity column, so its indent is the row's own prefix.
        const verdictIndent = ' '.repeat(
          CREW_MARKER_GUTTER +
            (row.index?.length ?? 0) +
            row.label.length +
            CREW_COLUMN_GAP.length * 2,
        );
        return (
          <Fragment key={seat.id}>
            {position > 0 && <Text color={t.border}>{`${SPINE_INDENT}${glyph('treeMid')}`}</Text>}
            <SeatRow row={row} color={seatColor(t, seat.id)} selected={seat.id === selected} />
            {seat.id === 'build' && seat.escalate !== undefined && (
              <EscalateRow escalate={seat.escalate} width={width} />
            )}
            {seat.id === 'review' && verdict !== undefined && (
              <Text color={t.reviewer}>
                {`${verdictIndent}${truncateWithEllipsis(
                  VERDICT_WORDS[verdict],
                  width - verdictIndent.length,
                )}`}
              </Text>
            )}
          </Fragment>
        );
      })}
    </Box>
  );
}
