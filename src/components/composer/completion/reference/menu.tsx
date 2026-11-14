import { ThemeText as Text, useTheme } from '../../../theme.js';
import { Box } from 'ink';
import { listRowLead } from '../../../list-row/lead.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { CLOSE_HINT, formatKeyHints, SELECT_HINT } from '../../../key-legend.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CompletionPanel } from '../panel.js';

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
      : formatKeyHints([SELECT_HINT, { key: 'tab/⏎', verb: 'fill' }, CLOSE_HINT]);
  return (
    <CompletionPanel
      items={filtered}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer={footer}
      itemKey={(file) => file}
      renderRow={({ item: file, isSelected, rowBg }) => (
        <Box width="100%" height={1} overflow="hidden" backgroundColor={rowBg}>
          <Box width={2} flexShrink={0}>
            <Text color={t.accent}>{listRowLead(isSelected ? 'active' : 'default')}</Text>
          </Box>
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
