import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../components/theme.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { glyph } from '../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import {
  CREW_COLUMN_GAP,
  CREW_IDENTITY_COLUMN,
  CREW_MARKER_GUTTER,
  formatCrewRow,
  type SeatBlockLayout,
} from './format.js';

const VERDICT_WORDS: Readonly<Record<CrewLabVerdict, string>> = {
  'cross-lab': 'reads the diff from another lab',
  'same-lab': 'same lab as the build',
};

function seatHue(theme: Theme, row: CrewRow): string {
  return theme[CREW_SEAT_ROLES[row.id]];
}

function padStartToCells(text: string, width: number): string {
  return `${' '.repeat(Math.max(0, width - getTerminalCellWidth(text)))}${text}`;
}

export type CrewRowViewProps = Readonly<{
  row: CrewRow;
  layout: SeatBlockLayout;
  isCursor: boolean;
  width: number;
}>;

export function CrewRowView({ row, layout, isCursor, width }: CrewRowViewProps) {
  const t = useTheme();
  const formatted = formatCrewRow({ row, layout });
  // The posture word is right-aligned to the row edge, so the identity fills its own column first.
  const postureWidth = width - CREW_IDENTITY_COLUMN - layout.identityWidth - CREW_COLUMN_GAP.length;
  const content =
    formatted.posture === undefined
      ? formatted.content
      : padTerminalDisplayTextEnd(formatted.content, layout.identityWidth);
  return (
    <Box>
      <Text color={t.accent}>
        {isCursor ? `${glyph('liveBar')} ` : ' '.repeat(CREW_MARKER_GUTTER)}
      </Text>
      <Text color={seatHue(t, row)} bold>
        {formatted.label}
      </Text>
      <Text color={t.text}>{`${CREW_COLUMN_GAP}${content}`}</Text>
      {formatted.posture !== undefined && (
        <Text color={t.textDim}>
          {`${CREW_COLUMN_GAP}${padStartToCells(formatted.posture, postureWidth)}`}
        </Text>
      )}
    </Box>
  );
}

export type CrewVerdictLineProps = Readonly<{ verdict: CrewLabVerdict; width: number }>;

export function CrewVerdictLine({ verdict, width }: CrewVerdictLineProps) {
  const t = useTheme();
  const lead = ' '.repeat(CREW_IDENTITY_COLUMN);
  return (
    <Text color={t.textDim}>
      {`${lead}${truncateTerminalDisplayText(VERDICT_WORDS[verdict], width - CREW_IDENTITY_COLUMN)}`}
    </Text>
  );
}
