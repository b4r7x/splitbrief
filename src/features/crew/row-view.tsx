import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { Box } from 'ink';
import type { Theme } from '../../core/theme/palette.js';
import type { CrewLabVerdict } from '../../core/crew/labs.js';
import type { CrewRow } from '../../core/crew/rows.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { glyph } from '../../lib/glyphs.js';
import { truncateTerminalDisplayText } from '../../utils/display-text/truncate.js';
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

function seatHue(theme: Theme, row: CrewRow): string | undefined {
  return theme[CREW_SEAT_ROLES[row.id]];
}

export type CrewRowViewProps = Readonly<{
  row: CrewRow;
  layout: SeatBlockLayout;
  isCursor: boolean;
}>;

export function CrewRowView({ row, layout, isCursor }: CrewRowViewProps) {
  const t = useTheme();
  const formatted = formatCrewRow({ row, layout });
  return (
    <Box>
      <Text color={t.accent}>
        {isCursor ? `${glyph('liveBar')} ` : ' '.repeat(CREW_MARKER_GUTTER)}
      </Text>
      <Text color={seatHue(t, row)} bold>
        {formatted.label}
      </Text>
      <Text color={t.text}>{`${CREW_COLUMN_GAP}${formatted.content}`}</Text>
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
