import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../components/theme.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { glyph, type GlyphName } from '../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { assertNever } from '../../utils/type-guards.js';
import {
  CREW_COLUMN_GAP,
  CREW_IDENTITY_COLUMN,
  CREW_MARKER_GUTTER,
  CREW_RAIL_WIDTH,
  formatCrewRow,
  type SeatBlockLayout,
} from './format.js';

const RAIL_GLYPHS: Readonly<Record<'node' | 'mid' | 'last', GlyphName>> = {
  node: 'stageDone',
  mid: 'treeBranch',
  last: 'treeLast',
};

const VERDICT_WORDS: Readonly<Record<CrewLabVerdict, string>> = {
  'cross-lab': 'reads the diff from another lab',
  'same-lab': 'same lab as the build',
};

function seatOf(row: CrewRow): CrewSeatId {
  switch (row.kind) {
    case 'seat':
      return row.id;
    case 'effort':
      return row.seatId;
    default:
      return assertNever(row);
  }
}

function seatHue(theme: Theme, row: CrewRow): string {
  return theme[CREW_SEAT_ROLES[seatOf(row)]];
}

function padStartToCells(text: string, width: number): string {
  return `${' '.repeat(Math.max(0, width - getTerminalCellWidth(text)))}${text}`;
}

export type CrewRowViewProps = Readonly<{
  row: CrewRow;
  layout: SeatBlockLayout;
  isCursor: boolean;
  width: number;
  planner: RunnerConfig;
}>;

export function CrewRowView({ row, layout, isCursor, width, planner }: CrewRowViewProps) {
  const t = useTheme();
  const formatted = formatCrewRow({ row, layout, planner });
  // The posture word is right-aligned to the row edge, so the identity fills its own column first.
  const postureWidth = width - CREW_IDENTITY_COLUMN - layout.identityWidth - CREW_COLUMN_GAP.length;
  const content =
    formatted.posture === undefined
      ? formatted.content
      : padTerminalDisplayTextEnd(formatted.content, layout.identityWidth);
  const isDimmed = row.kind === 'effort' && !row.deliverable && !row.inherited;

  return (
    <Box>
      <Text color={t.accent}>
        {isCursor ? `${glyph('liveBar')} ` : ' '.repeat(CREW_MARKER_GUTTER)}
      </Text>
      <Text color={t.border}>{`${glyph(RAIL_GLYPHS[formatted.branch])} `}</Text>
      <Text color={isDimmed ? t.textDim : seatHue(t, row)} bold={!isDimmed}>
        {formatted.label}
      </Text>
      <Text color={isDimmed ? t.textDim : t.text}>{`${CREW_COLUMN_GAP}${content}`}</Text>
      {formatted.posture !== undefined && (
        <Text color={t.textDim}>
          {`${CREW_COLUMN_GAP}${padStartToCells(formatted.posture, postureWidth)}`}
        </Text>
      )}
    </Box>
  );
}

export function CrewSpine() {
  const t = useTheme();
  return <Text color={t.border}>{`${' '.repeat(CREW_MARKER_GUTTER)}${glyph('treeMid')}`}</Text>;
}

export type CrewVerdictLineProps = Readonly<{ verdict: CrewLabVerdict; width: number }>;

export function CrewVerdictLine({ verdict, width }: CrewVerdictLineProps) {
  const t = useTheme();
  const lead = `${' '.repeat(CREW_MARKER_GUTTER)}${glyph('treeLast')} `;
  return (
    <Text color={t.textDim}>
      {`${lead}${truncateTerminalDisplayText(VERDICT_WORDS[verdict], width - CREW_MARKER_GUTTER - CREW_RAIL_WIDTH)}`}
    </Text>
  );
}
