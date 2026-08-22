import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { CrewPreset } from '../../core/crew/presets.js';
import { glyph } from '../../lib/glyphs.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import { CREW_COLUMN_GAP, CREW_MARKER_GUTTER } from './format.js';

export type PresetRowProps = Readonly<{
  presets: readonly CrewPreset[];
  selected: string | undefined;
  width: number;
}>;

export function PresetRow({ presets, selected, width }: PresetRowProps) {
  const t = useTheme();
  const labelWidth = Math.max(0, ...presets.map((preset) => preset.label.length));
  const descriptionWidth = width - CREW_MARKER_GUTTER - labelWidth - CREW_COLUMN_GAP.length;

  return (
    <Box flexDirection="column">
      {presets.map((preset) => {
        const isSelected = preset.id === selected;
        return (
          <Box key={preset.id}>
            <Text color={t.accent}>
              {isSelected ? `${glyph('promptMarker')} ` : ' '.repeat(CREW_MARKER_GUTTER)}
            </Text>
            <Text color={t.accent} bold={isSelected}>
              {preset.label.padEnd(labelWidth)}
            </Text>
            <Text color={t.textDim}>
              {`${CREW_COLUMN_GAP}${truncateWithEllipsis(preset.description, descriptionWidth)}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
