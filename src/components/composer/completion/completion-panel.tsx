import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.js';
import { windowSlice } from '../../pickers/scroll-window.js';

export function CompletionPanel<T>({
  items,
  selectedIndex,
  maxVisible,
  footer,
  isOpen,
  itemKey,
  renderRow,
  renderEmpty,
}: {
  items: T[];
  selectedIndex: number;
  maxVisible: number;
  footer: string;
  isOpen?: boolean | undefined;
  itemKey: (item: T) => string;
  renderRow: (opts: {
    item: T;
    globalIndex: number;
    isSelected: boolean;
    rowBg: string;
    panelBg: string;
    visibleItems: T[];
  }) => ReactNode;
  renderEmpty?: ((panelBg: string) => ReactNode) | undefined;
}) {
  const t = useTheme();
  if (!(isOpen ?? items.length > 0)) return null;

  const { scrollOffset, visibleSlice, showScrollUp, showScrollDown } = windowSlice({
    items,
    selectedIndex,
    windowSize: maxVisible,
  });
  const panelBg = t.suggestionPanelBg;
  const emptyRow = renderEmpty?.(panelBg);

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
        <Box width="100%" height={1} overflow="hidden" backgroundColor={panelBg}>
          <Text color={t.scrollIndicator}> ↑ more</Text>
          <Box flexGrow={1} backgroundColor={panelBg} />
        </Box>
      )}
      {visibleSlice.map((item, i) => {
        const globalIndex = scrollOffset + i;
        const isSelected = globalIndex === selectedIndex;
        const rowBg = isSelected ? t.selectionBg : panelBg;
        return (
          <Box
            key={itemKey(item)}
            width="100%"
            height={1}
            overflow="hidden"
            backgroundColor={rowBg}
            paddingX={1}
          >
            {renderRow({
              item,
              globalIndex,
              isSelected,
              rowBg,
              panelBg,
              visibleItems: visibleSlice,
            })}
          </Box>
        );
      })}
      {emptyRow && (
        <Box width="100%" height={1} overflow="hidden" backgroundColor={panelBg}>
          {emptyRow}
        </Box>
      )}
      {showScrollDown && (
        <Box width="100%" height={1} overflow="hidden" backgroundColor={panelBg}>
          <Text color={t.scrollIndicator}> ↓ more</Text>
          <Box flexGrow={1} backgroundColor={panelBg} />
        </Box>
      )}
      <Box width="100%" height={1} backgroundColor={panelBg} />
      <Box
        width="100%"
        height={1}
        overflow="hidden"
        justifyContent="center"
        backgroundColor={panelBg}
      >
        <Text color={t.textDim} wrap="truncate-end">
          {footer}
        </Text>
      </Box>
    </Box>
  );
}
