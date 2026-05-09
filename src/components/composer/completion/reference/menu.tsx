import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import { computeScrollOffset } from '../../../pickers/picker-utils.js';

interface ReferenceCompletionMenuProps {
  filtered: string[];
  selectedIndex: number;
  maxVisible: number;
}

export function ReferenceCompletionMenu({ filtered, selectedIndex, maxVisible }: ReferenceCompletionMenuProps) {
  const t = useTheme();
  if (filtered.length === 0) return null;

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
      {visibleSlice.map((file, i) => {
        const globalIndex = scrollOffset + i;
        const isSelected = globalIndex === selectedIndex;
        const rowBg = isSelected ? t.selectionBg : panelBg;
        return (
          <Box
            key={file}
            width="100%"
            backgroundColor={rowBg}
            paddingX={1}
          >
            <Text color={isSelected ? t.accent : t.textDim}>
              {isSelected ? '▸' : ' '}
            </Text>
            <Text> </Text>
            <Box flexGrow={1} flexShrink={1} backgroundColor={rowBg}>
              <Text color={isSelected ? t.accent : t.textDim} bold={isSelected} wrap="truncate-middle">
                {file}
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
      <Box width="100%" height={1} backgroundColor={panelBg} />
      <Box width="100%" justifyContent="center" backgroundColor={panelBg}>
        <Text color={t.textDim}>↑↓ select  Tab/Enter fill  Esc close</Text>
      </Box>
    </Box>
  );
}
