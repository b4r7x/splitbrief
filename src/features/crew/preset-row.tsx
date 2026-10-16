import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { Box } from 'ink';
import { listRowLead } from '../../components/list-row.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { CLI_TOOL_CATALOG } from '../../core/runners/cli-tool-catalog.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../utils/display-text.js';
import { CREW_COLUMN_GAP, CREW_MARKER_GUTTER } from './format.js';

/** Preset labels sit on the seat label edge: the marker gutter. */
const LABEL_COLUMN = CREW_MARKER_GUTTER;
const UNAVAILABLE = 'Unavailable';

export type PresetRowViewProps = Readonly<{
  preset: CrewPreset;
  isCursor: boolean;
  width: number;
  labelWidth: number;
}>;

export function PresetRowView({ preset, isCursor, width, labelWidth }: PresetRowViewProps) {
  const t = useTheme();
  const gutter = listRowLead(isCursor ? 'active' : 'default');

  // The label column never grows past the row, and the text after it shows only in the room left.
  const labelCells = Math.min(labelWidth, width - LABEL_COLUMN);
  const label = padTerminalDisplayTextEnd(
    truncateTerminalDisplayText(preset.label, labelCells),
    labelCells,
  );
  const room = width - LABEL_COLUMN - labelCells - getTerminalCellWidth(CREW_COLUMN_GAP);

  if (preset.notReady.length > 0) {
    const needs = preset.notReady.map((tool) => CLI_TOOL_CATALOG[tool].displayName).join(', ');
    const reason = truncateTerminalDisplayText(
      `${SOFT_SEP}needs ${needs}`,
      room - getTerminalCellWidth(UNAVAILABLE),
    );
    return (
      <Box>
        <Text color={t.accent}>{gutter}</Text>
        <Text color={t.textDim}>{label}</Text>
        {room >= getTerminalCellWidth(UNAVAILABLE) && (
          <Text color={t.warning}>{`${CREW_COLUMN_GAP}${UNAVAILABLE}`}</Text>
        )}
        <Text color={t.textDim}>{reason}</Text>
      </Box>
    );
  }

  const description = truncateTerminalDisplayText(preset.description, room);
  return (
    <Box>
      <Text color={t.accent}>{gutter}</Text>
      <Text color={isCursor ? t.accent : t.text} bold={isCursor}>
        {label}
      </Text>
      {description !== '' && <Text color={t.textDim}>{`${CREW_COLUMN_GAP}${description}`}</Text>}
    </Box>
  );
}
