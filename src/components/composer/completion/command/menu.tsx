import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import { computeScrollOffset } from '../../../pickers/picker-utils.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';

interface CommandCompletionMenuProps {
  filtered: RuntimeCommandDef[];
  selectedIndex: number;
  fuzzyMatch?: RuntimeCommandDef | null;
  maxVisible: number;
}

export function CommandCompletionMenu({ filtered, selectedIndex, fuzzyMatch, maxVisible }: CommandCompletionMenuProps) {
  const t = useTheme();
  if (filtered.length === 0 && !fuzzyMatch) return null;

  const scrollOffset = computeScrollOffset(selectedIndex, maxVisible, filtered.length);
  const visibleSlice = filtered.slice(scrollOffset, scrollOffset + maxVisible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < filtered.length;
  const panelBg = t.suggestionPanelBg;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      backgroundColor={panelBg}
      paddingX={1}
      width="100%"
    >
      {showScrollUp && (
        <Box width="100%" backgroundColor={panelBg}>
          <Text color={t.scrollIndicator}>  ↑ more</Text>
          <Box flexGrow={1} backgroundColor={panelBg} />
        </Box>
      )}
      {visibleSlice.map((cmd, i) => {
        const globalIndex = scrollOffset + i;
        const isSelected = globalIndex === selectedIndex;
        const rowBg = isSelected ? t.selectionBg : panelBg;
        return (
          <Box
            key={cmd.name}
            width="100%"
            backgroundColor={rowBg}
            paddingX={1}
          >
            <Text color={isSelected ? t.accent : t.textDim}>
              {isSelected ? '▸' : ' '}
            </Text>
            <Text> </Text>
            <Box width={14} backgroundColor={rowBg}>
              <Text color={isSelected ? t.accent : t.text} bold={isSelected} wrap="truncate-end">
                {cmd.name}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} backgroundColor={rowBg}>
              <Text color={isSelected ? t.text : t.textDim} wrap="truncate-end">
                {cmd.description}{cmd.shortcut ? ` [${cmd.shortcut}]` : ''}
              </Text>
            </Box>
          </Box>
        );
      })}
      {showScrollDown && (
        <Box width="100%" backgroundColor={panelBg}>
          <Text color={t.scrollIndicator}>  ↓ more</Text>
          <Box flexGrow={1} backgroundColor={panelBg} />
        </Box>
      )}
      {fuzzyMatch && filtered.length === 0 && (
        <Box width="100%" backgroundColor={panelBg} paddingX={1}>
          <Text color={t.textDim}>{'▸'}</Text>
          <Text> </Text>
          <Box width={14} backgroundColor={panelBg}>
            <Text color={t.textDim} wrap="truncate-end">{fuzzyMatch.name}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} backgroundColor={panelBg}>
            <Text color={t.textDim} wrap="truncate-end">{fuzzyMatch.description} (fuzzy)</Text>
          </Box>
        </Box>
      )}
      <Box width="100%" height={1} backgroundColor={panelBg} />
      <Box width="100%" justifyContent="center" backgroundColor={panelBg}>
        <Text color={t.textDim}>↑↓ select  Tab fill  Enter run  Esc close</Text>
      </Box>
    </Box>
  );
}
