import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { useFilterableList } from '../hooks/use-filterable-list.js';
import { computeScrollOffset } from './picker-utils.js';

export interface PickerShellProps<T> {
  title: string;
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  renderRow: (item: T, isSelected: boolean) => React.ReactNode;
  getKey: (item: T) => string;
  onSelect: (item: T) => void;
  onCancel: () => void;
  emptyText?: string;
  emptyHint?: string;
  footerHint?: string;
  extraContent?: React.ReactNode;
}

export function PickerShell<T>({
  title,
  items,
  filterFn,
  renderRow,
  getKey,
  onSelect,
  onCancel,
  emptyText = 'No items found.',
  emptyHint,
  footerHint = '\u2191\u2193 navigate  Enter select  Esc cancel',
  extraContent,
}: PickerShellProps<T>) {
  const t = useTheme();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const { filter, filtered, selectedIndex } = useFilterableList({
    items,
    filterFn,
    onSelect,
    onClose: onCancel,
  });

  const contentWidth = Math.min(cols - 4, isSmall ? 76 : 110);
  const maxVisible = Math.max(rows - 10, 5);
  const scrollOffset = computeScrollOffset(selectedIndex, maxVisible, filtered.length);
  const visibleSlice = filtered.slice(scrollOffset, scrollOffset + maxVisible);

  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < filtered.length;

  if (items.length === 0) {
    return (
      <Box flexDirection="column" width={cols} height={rows} alignItems="center" justifyContent="center">
        <Box flexDirection="column" width={contentWidth}>
          <Box justifyContent="center" marginBottom={1}>
            <Text bold color={t.accent}>{title}</Text>
          </Box>
          <Text color={t.textDim}>  {emptyText}</Text>
          {emptyHint && <Text color={t.textDim}>  {emptyHint}</Text>}
          <Box justifyContent="center" marginTop={1}>
            <Text color={t.textDim}>Esc close</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols} height={rows} alignItems="center" paddingTop={1}>
      <Box flexDirection="column" width={contentWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>{title}</Text>
          <Text color={t.textDim}>{' ('}{filtered.length}{' available)'}</Text>
        </Box>

        <Box borderStyle="round" borderColor={t.border} paddingX={1} marginBottom={1} width={contentWidth}>
          <Text color={t.accent}>{'> '}</Text>
          <Text>{filter || <Text color={t.textDim}>Type to filter...</Text>}</Text>
        </Box>

        {showScrollUp && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

        <Box flexDirection="column">
          {visibleSlice.map((item, i) => (
            <React.Fragment key={getKey(item)}>
              {renderRow(item, scrollOffset + i === selectedIndex)}
            </React.Fragment>
          ))}
          {filtered.length === 0 && <Text color={t.textDim}>{'  No matches'}</Text>}
        </Box>

        {showScrollDown && <Text color={t.textDim}>{'  \u2193 more'}</Text>}

        {extraContent}
      </Box>

      <Box flexGrow={1} />

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{footerHint}</Text>
      </Box>
    </Box>
  );
}
