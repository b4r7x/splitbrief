import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { glyph } from '../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { CREW_COLUMN_GAP, CREW_MARKER_GUTTER, CREW_RAIL_WIDTH } from './format.js';

/** Preset labels sit on the seat label edge: the marker gutter plus the rail column. */
const LABEL_COLUMN = CREW_MARKER_GUTTER + CREW_RAIL_WIDTH;

export type PresetRowViewProps = Readonly<{
  preset: CrewPreset;
  isCursor: boolean;
  width: number;
  labelWidth: number;
}>;

export function PresetRowView({ preset, isCursor, width, labelWidth }: PresetRowViewProps) {
  const t = useTheme();
  const gutter = isCursor ? `${glyph('liveBar')} ` : ' '.repeat(CREW_MARKER_GUTTER);

  const description = truncateTerminalDisplayText(
    preset.description,
    width - LABEL_COLUMN - labelWidth - getTerminalCellWidth(CREW_COLUMN_GAP),
  );

  return (
    <Box>
      <Text color={t.accent}>{`${gutter}${' '.repeat(CREW_RAIL_WIDTH)}`}</Text>
      <Text color={t.accent} bold={isCursor}>
        {padTerminalDisplayTextEnd(preset.label, labelWidth)}
      </Text>
      <Text color={t.textDim}>{`${CREW_COLUMN_GAP}${description}`}</Text>
    </Box>
  );
}
