import { Box, Text } from 'ink';
import { ScrollIndicator } from '../scroll-indicator.js';
import { useTheme } from '../theme.js';
import { computeScrollOffset } from '../pickers/picker-utils.js';

interface AtFileSuggestionsProps {
  filtered: string[];
  selectedIndex: number;
  maxVisible: number;
}

export function AtFileSuggestions({ filtered, selectedIndex, maxVisible }: AtFileSuggestionsProps) {
  const t = useTheme();
  if (filtered.length === 0) return null;

  const scrollOffset = computeScrollOffset(selectedIndex, maxVisible, filtered.length);
  const visibleSlice = filtered.slice(scrollOffset, scrollOffset + maxVisible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < filtered.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      backgroundColor={t.panelBg}
      paddingX={1}
      width="100%"
    >
      <ScrollIndicator show={showScrollUp} direction="up" />
      {visibleSlice.map((file, i) => {
        const globalIndex = scrollOffset + i;
        const isSelected = globalIndex === selectedIndex;
        return (
          <Box
            key={file}
            backgroundColor={isSelected ? t.selectionBg : undefined}
            paddingX={1}
          >
            <Text color={isSelected ? t.accent : t.textDim}>
              {isSelected ? '▸' : ' '}
            </Text>
            <Text> </Text>
            <Text color={isSelected ? t.accent : t.textDim} bold={isSelected}>
              {file}
            </Text>
          </Box>
        );
      })}
      <ScrollIndicator show={showScrollDown} direction="down" />
      <Box justifyContent="center" paddingTop={1}>
        <Text color={t.textDim}>↑↓ select  Tab fill  Esc close</Text>
      </Box>
    </Box>
  );
}
