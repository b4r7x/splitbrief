import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { ScrollIndicator } from '../scroll-indicator.js';
import { windowSlice } from './scroll-window.js';
import { CursorCell } from './cursor-cell.js';

interface SingleColumnPickerProps<T> {
  label: string;
  items: T[];
  filter: string;
  selectedIndex: number;
  isActive: boolean;
  height: number;
  visibleRows: number;
  getKey: (item: T) => string;
  renderRow: (item: T, isCursor: boolean, maxWidth: number) => ReactNode;
  contentMaxWidth: number;
  placeholderWhenEmpty?: ReactNode;
  hideFilterRow?: boolean;
  customFilterPrompt?: ReactNode;
}

export function SingleColumnPicker<T>({
  label,
  items,
  filter,
  selectedIndex,
  isActive,
  height,
  visibleRows,
  getKey,
  renderRow,
  contentMaxWidth,
  placeholderWhenEmpty,
  hideFilterRow,
  customFilterPrompt,
}: SingleColumnPickerProps<T>) {
  const t = useTheme();

  const {
    scrollOffset,
    visibleSlice: slice,
    showScrollUp,
    showScrollDown,
  } = windowSlice(items, selectedIndex, visibleRows);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      height={height}
      borderStyle="round"
      borderColor={isActive ? t.accent : t.border}
      paddingX={2}
    >
      <Text bold color={isActive ? t.accent : t.textDim}>
        {label}
      </Text>

      {!hideFilterRow && (
        <Box>
          <Text color={isActive ? t.accent : t.textDim}>{'> '}</Text>
          {customFilterPrompt ??
            (filter ? (
              <Text color={t.text}>{filter}</Text>
            ) : (
              <Text color={t.textDim}>Type to filter...</Text>
            ))}
        </Box>
      )}

      {!hideFilterRow && showScrollUp && <ScrollIndicator show direction="up" />}

      {items.length === 0
        ? (placeholderWhenEmpty ?? <Text color={t.textDim}>No items</Text>)
        : slice.map((item, i) => {
            const idx = scrollOffset + i;
            const isCursor = isActive && idx === selectedIndex;
            return (
              <Box key={getKey(item)}>
                <CursorCell isCursor={isCursor} dimWhenInactive />
                {renderRow(item, isCursor, contentMaxWidth)}
              </Box>
            );
          })}

      {!hideFilterRow &&
        (showScrollDown ? <ScrollIndicator show direction="down" /> : <Text> </Text>)}
    </Box>
  );
}
