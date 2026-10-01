import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { listRowLead } from '../../components/list-row.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { CREW_COLUMN_GAP, CREW_MARKER_GUTTER } from './format.js';

/** Preset labels sit on the seat label edge: the marker gutter. */
const LABEL_COLUMN = CREW_MARKER_GUTTER;

export type PresetRowViewProps = Readonly<{
  preset: CrewPreset;
  isCursor: boolean;
  width: number;
  labelWidth: number;
}>;

export function PresetRowView({ preset, isCursor, width, labelWidth }: PresetRowViewProps) {
  const t = useTheme();
  const gutter = listRowLead(isCursor ? 'active' : 'default');

  const description = truncateTerminalDisplayText(
    preset.description,
    width - LABEL_COLUMN - labelWidth - getTerminalCellWidth(CREW_COLUMN_GAP),
  );

  return (
    <Box>
      <Text color={t.accent}>{gutter}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>
        {padTerminalDisplayTextEnd(preset.label, labelWidth)}
      </Text>
      <Text color={t.textDim}>{`${CREW_COLUMN_GAP}${description}`}</Text>
    </Box>
  );
}
