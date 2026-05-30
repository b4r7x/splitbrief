import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import { CompletionPanel } from '../completion-panel.js';

interface ReferenceCompletionMenuProps {
  filtered: string[];
  selectedIndex: number;
  maxVisible: number;
}

export function ReferenceCompletionMenu({
  filtered,
  selectedIndex,
  maxVisible,
}: ReferenceCompletionMenuProps) {
  const t = useTheme();
  return (
    <CompletionPanel
      items={filtered}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer="↑↓ select  Tab/Enter fill  Esc close"
      itemKey={(file) => file}
      renderRow={({ item: file, isSelected, rowBg }) => (
        <>
          <Text color={isSelected ? t.accent : t.textDim}>{isSelected ? '▸' : ' '}</Text>
          <Text> </Text>
          <Box flexGrow={1} flexShrink={1} backgroundColor={rowBg}>
            <Text
              color={isSelected ? t.accent : t.textDim}
              bold={isSelected}
              wrap="truncate-middle"
            >
              {file}
            </Text>
          </Box>
        </>
      )}
    />
  );
}
