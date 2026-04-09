import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { ScrollIndicator } from '../../ui/scroll-indicator.js';
import { CURSOR, NO_CURSOR, computeScrollOffset } from './picker-utils.js';

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
  footer?: ReactNode;
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
  footer,
}: SingleColumnPickerProps<T>) {
  const t = useTheme();

  const scrollOffset = computeScrollOffset(selectedIndex, visibleRows, items.length);
  const slice = items.slice(scrollOffset, scrollOffset + visibleRows);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + visibleRows < items.length;

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
      <Text bold color={isActive ? t.accent : t.textDim}>{label}</Text>

      {!hideFilterRow && (
        <Box marginBottom={1}>
          <Text color={isActive ? t.accent : t.textDim}>{'> '}</Text>
          {customFilterPrompt ?? (filter
            ? <Text color={t.text}>{filter}</Text>
            : <Text color={t.textDim}>Type to filter...</Text>)}
        </Box>
      )}

      {!hideFilterRow && <ScrollIndicator show={showScrollUp} direction="up" />}

      {items.length === 0 ? (
        placeholderWhenEmpty ?? <Text color={t.textDim}>No items</Text>
      ) : (
        slice.map((item, i) => {
          const idx = scrollOffset + i;
          const isCursor = isActive && idx === selectedIndex;
          return (
            <Box key={getKey(item)}>
              <Text color={isCursor ? t.accent : t.textDim}>
                {isCursor ? CURSOR : NO_CURSOR}
              </Text>
              {renderRow(item, isCursor, contentMaxWidth)}
            </Box>
          );
        })
      )}

      {footer}

      {!hideFilterRow && <ScrollIndicator show={showScrollDown} direction="down" />}
    </Box>
  );
}
