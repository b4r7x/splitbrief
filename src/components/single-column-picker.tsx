import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../ui/theme.js';

export interface SingleColumnPickerProps<T> {
  label: string;
  items: T[];
  filter: string;
  selectedIndex: number;
  isActive: boolean;
  height: number;
  visibleRows: number;
  scrollOffset: number;
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
  scrollOffset,
  getKey,
  renderRow,
  contentMaxWidth,
  placeholderWhenEmpty,
  hideFilterRow,
  customFilterPrompt,
  footer,
}: SingleColumnPickerProps<T>) {
  const t = useTheme();

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

      {showScrollUp && !hideFilterRow && <Text color={t.textDim}>{'\u2191 more'}</Text>}

      {items.length === 0 ? (
        placeholderWhenEmpty ?? <Text color={t.textDim}>No items</Text>
      ) : (
        slice.map((item, i) => {
          const idx = scrollOffset + i;
          const isCursor = isActive && idx === selectedIndex;
          return (
            <Box key={getKey(item)}>
              <Text color={isCursor ? t.accent : t.textDim}>
                {isCursor ? '\u25B8 ' : '  '}
              </Text>
              {renderRow(item, isCursor, contentMaxWidth)}
            </Box>
          );
        })
      )}

      {footer}

      {showScrollDown && !hideFilterRow && <Text color={t.textDim}>{'\u2193 more'}</Text>}
    </Box>
  );
}
