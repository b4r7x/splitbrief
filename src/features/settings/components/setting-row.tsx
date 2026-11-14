import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { ListRow } from '../../../components/list-row/row.js';
import type { SettingDef } from '../../../core/settings/catalog.js';
import { glyph } from '../../../lib/glyphs.js';
import { stripTerminalControls } from '../../../utils/display-text/sanitize.js';
import { displayValue } from '../presentation.js';

export function SettingRow({
  def,
  label,
  value,
  editBuffer,
  isCursor,
  width,
  detectedContextLength,
}: {
  def: SettingDef;
  label: string;
  value: unknown;
  /** The text typed so far while the row is in edit. */
  editBuffer: string | undefined;
  isCursor: boolean;
  width: number;
  detectedContextLength: number | undefined;
}) {
  const t = useTheme();

  if (editBuffer !== undefined) {
    return (
      <Box width={width} height={1} overflow="hidden">
        <Text color={t.textDim}>{'  '}</Text>
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={t.text} wrap="truncate-end">
            {label}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text
            color={t.accent}
          >{`[${stripTerminalControls(editBuffer)}${glyph('editCursor')}]`}</Text>
        </Box>
      </Box>
    );
  }

  const boolTrue = def.kind === 'boolean' && value === true;
  return (
    <ListRow
      label={label}
      state={isCursor ? 'active' : 'default'}
      metadata={boolTrue ? undefined : displayValue(def, value, { detectedContextLength })}
      metadataTone="text"
      selected={boolTrue ? true : undefined}
      width={width}
    />
  );
}
