import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import { CursorCell } from '../../../pickers/cursor-cell.js';
import { SOFT_SEP } from '../../../separators.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CompletionPanel } from '../completion-panel.js';

const NARROW_FOOTER_COLS = 50;

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
  const cols = terminalSizeStore.use((s) => s.cols);
  const footer =
    cols < NARROW_FOOTER_COLS
      ? ['↑↓', '⏎', 'esc'].join(SOFT_SEP)
      : ['↑↓ select', 'tab/⏎ fill', 'esc close'].join(SOFT_SEP);
  return (
    <CompletionPanel
      items={filtered}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer={footer}
      itemKey={(file) => file}
      renderRow={({ item: file, isSelected, rowBg }) => (
        <Box width="100%" height={1} overflow="hidden" backgroundColor={rowBg}>
          <CursorCell isCursor={isSelected} dimWhenInactive />
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" backgroundColor={rowBg}>
            <Text
              color={isSelected ? t.accent : t.textDim}
              bold={isSelected}
              wrap="truncate-middle"
            >
              {file}
            </Text>
          </Box>
        </Box>
      )}
    />
  );
}
