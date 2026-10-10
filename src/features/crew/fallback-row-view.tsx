import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { FALLBACK_NONE_WORDS, type FallbackRow } from '../../core/crew/fallback.js';
import {
  CREW_IDENTITY_SEPARATOR,
  CREW_LABEL_WIDTH,
  CREW_SEAT_LABELS,
  PLANNER_INHERITANCE,
  cutSeatIdentity,
} from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { CREW_COLUMN_GAP, CREW_IDENTITY_COLUMN, CREW_MARKER_GUTTER } from './format.js';

export type FallbackRowViewProps = Readonly<{
  row: FallbackRow;
  isCursor: boolean;
  width: number;
}>;

export function FallbackRowView({ row, isCursor, width }: FallbackRowViewProps) {
  const t = useTheme();
  const identity = row.identity ?? FALLBACK_NONE_WORDS;
  const note = row.note === undefined ? '' : `${CREW_IDENTITY_SEPARATOR}${row.note}`;
  const content = cutSeatIdentity(
    row.inherited ? `${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${identity}` : identity,
    width - CREW_IDENTITY_COLUMN - getTerminalCellWidth(note),
  );

  return (
    <Box width={width} height={1} overflow="hidden">
      <Text color={t.accent}>
        {isCursor ? `${glyph('liveBar')} ` : ' '.repeat(CREW_MARKER_GUTTER)}
      </Text>
      <Text color={t[CREW_SEAT_ROLES[row.id]]} bold>
        {CREW_SEAT_LABELS[row.id].padEnd(CREW_LABEL_WIDTH)}
      </Text>
      <Text color={row.identity === undefined ? t.textDim : t.text}>
        {`${CREW_COLUMN_GAP}${content}`}
      </Text>
      {note !== '' && <Text color={t.warning}>{note}</Text>}
    </Box>
  );
}
