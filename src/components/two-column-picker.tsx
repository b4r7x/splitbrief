import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { computeScrollOffset } from '../ui/picker-utils.js';

export interface TwoColumnPickerProps<L, R> {
  title: string;
  leftItems: L[];
  rightItems: R[];
  leftRenderRow: (item: L, isCursor: boolean) => ReactNode;
  rightRenderRow: (item: R, isCursor: boolean) => ReactNode;
  leftGetKey: (item: L) => string;
  rightGetKey: (item: R) => string;
  leftFilterFn: (item: L, query: string) => boolean;
  rightFilterFn: (item: R, query: string) => boolean;
  onLeftChange: (item: L) => void;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  rightPlaceholder?: ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  inputDisabled?: boolean;
}

export function TwoColumnPicker<L, R>({
  title,
  leftItems,
  rightItems,
  leftRenderRow,
  rightRenderRow,
  leftGetKey,
  rightGetKey,
  leftFilterFn,
  rightFilterFn,
  onLeftChange,
  onConfirm,
  onCancel,
  rightPlaceholder,
  leftLabel = 'Backends',
  rightLabel = 'Models',
  inputDisabled,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>('left');
  const [leftIndex, setLeftIndex] = useState(0);
  const [rightIndex, setRightIndex] = useState(0);
  const [leftFilter, setLeftFilter] = useState('');
  const [rightFilter, setRightFilter] = useState('');

  const filteredLeft = leftFilter
    ? leftItems.filter((item) => leftFilterFn(item, leftFilter))
    : leftItems;
  const filteredRight = rightFilter
    ? rightItems.filter((item) => rightFilterFn(item, rightFilter))
    : rightItems;

  const effectiveLeftIndex = Math.min(leftIndex, Math.max(0, filteredLeft.length - 1));
  const effectiveRightIndex = Math.min(rightIndex, Math.max(0, filteredRight.length - 1));

  const contentWidth = Math.min(cols - 4, isSmall ? 76 : 110);
  const leftWidth = Math.floor(contentWidth * 0.4);
  const rightWidth = contentWidth - leftWidth - 2;
  const maxVisible = Math.max(rows - 8, 5);

  const leftScrollOffset = computeScrollOffset(effectiveLeftIndex, maxVisible, filteredLeft.length);
  const rightScrollOffset = computeScrollOffset(effectiveRightIndex, maxVisible, filteredRight.length);
  const leftSlice = filteredLeft.slice(leftScrollOffset, leftScrollOffset + maxVisible);
  const rightSlice = filteredRight.slice(rightScrollOffset, rightScrollOffset + maxVisible);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.leftArrow) {
      setActiveColumn('left');
      return;
    }
    if (key.rightArrow) {
      if (rightItems.length > 0 || rightPlaceholder) {
        setActiveColumn('right');
      }
      return;
    }

    if (key.upArrow) {
      if (activeColumn === 'left') {
        if (filteredLeft.length === 0) return;
        const next = effectiveLeftIndex > 0 ? effectiveLeftIndex - 1 : filteredLeft.length - 1;
        setLeftIndex(next);
        if (filteredLeft[next]) {
          onLeftChange(filteredLeft[next]);
          setRightIndex(0);
          setRightFilter('');
        }
      } else {
        if (filteredRight.length === 0) return;
        setRightIndex(effectiveRightIndex > 0 ? effectiveRightIndex - 1 : filteredRight.length - 1);
      }
      return;
    }
    if (key.downArrow) {
      if (activeColumn === 'left') {
        if (filteredLeft.length === 0) return;
        const next = effectiveLeftIndex < filteredLeft.length - 1 ? effectiveLeftIndex + 1 : 0;
        setLeftIndex(next);
        if (filteredLeft[next]) {
          onLeftChange(filteredLeft[next]);
          setRightIndex(0);
          setRightFilter('');
        }
      } else {
        if (filteredRight.length === 0) return;
        setRightIndex(effectiveRightIndex < filteredRight.length - 1 ? effectiveRightIndex + 1 : 0);
      }
      return;
    }

    if (key.return) {
      if (activeColumn === 'left') {
        if (filteredRight.length > 0) {
          setActiveColumn('right');
        } else if (!rightPlaceholder) {
          const leftItem = filteredLeft[effectiveLeftIndex];
          if (leftItem) onConfirm(leftItem, null);
        }
      } else {
        const leftItem = filteredLeft[effectiveLeftIndex];
        const rightItem = filteredRight[effectiveRightIndex] ?? null;
        if (leftItem) onConfirm(leftItem, rightItem);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (activeColumn === 'left') {
        setLeftFilter((prev) => prev.slice(0, -1));
        setLeftIndex(0);
      } else {
        setRightFilter((prev) => prev.slice(0, -1));
        setRightIndex(0);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (activeColumn === 'left') {
        setLeftFilter((prev) => prev + input);
        setLeftIndex(0);
      } else {
        setRightFilter((prev) => prev + input);
        setRightIndex(0);
      }
    }
  }, { isActive: !inputDisabled });

  const leftActive = activeColumn === 'left';
  const rightActive = activeColumn === 'right';

  const showLeftScrollUp = leftScrollOffset > 0;
  const showLeftScrollDown = leftScrollOffset + maxVisible < filteredLeft.length;
  const showRightScrollUp = rightScrollOffset > 0;
  const showRightScrollDown = rightScrollOffset + maxVisible < filteredRight.length;

  return (
    <Box flexDirection="column" width={cols} height={rows} alignItems="center" paddingTop={1}>
      <Box flexDirection="column" width={contentWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>{title}</Text>
        </Box>

        <Box gap={2}>
          <Box flexDirection="column" width={leftWidth}>
            <Text bold={leftActive} color={leftActive ? t.accent : t.textDim}>
              {leftLabel}{leftFilter ? ` [${leftFilter}]` : ''}
            </Text>
            <Text color={leftActive ? t.accent : t.textDim}>
              {'─'.repeat(leftWidth)}
            </Text>

            {showLeftScrollUp && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

            {filteredLeft.length === 0 ? (
              <Text color={t.textDim}>  No items</Text>
            ) : (
              leftSlice.map((item, i) => {
                const idx = leftScrollOffset + i;
                const isCursor = leftActive && idx === effectiveLeftIndex;
                return (
                  <Box key={leftGetKey(item)}>
                    <Text color={isCursor ? t.accent : t.textDim}>
                      {isCursor ? '\u25B8 ' : '  '}
                    </Text>
                    {leftRenderRow(item, isCursor)}
                  </Box>
                );
              })
            )}

            {showLeftScrollDown && <Text color={t.textDim}>{'  \u2193 more'}</Text>}
          </Box>

          <Box flexDirection="column" width={rightWidth}>
            <Text bold={rightActive} color={rightActive ? t.accent : t.textDim}>
              {rightLabel}{rightFilter ? ` [${rightFilter}]` : ''}
            </Text>
            <Text color={rightActive ? t.accent : t.textDim}>
              {'─'.repeat(rightWidth)}
            </Text>

            {showRightScrollUp && <Text color={t.textDim}>{'  \u2191 more'}</Text>}

            {filteredRight.length === 0 ? (
              rightPlaceholder ?? <Text color={t.textDim}>  No models available</Text>
            ) : (
              rightSlice.map((item, i) => {
                const idx = rightScrollOffset + i;
                const isCursor = rightActive && idx === effectiveRightIndex;
                return (
                  <Box key={rightGetKey(item)}>
                    <Text color={isCursor ? t.accent : t.textDim}>
                      {isCursor ? '\u25B8 ' : '  '}
                    </Text>
                    {rightRenderRow(item, isCursor)}
                  </Box>
                );
              })
            )}

            {showRightScrollDown && <Text color={t.textDim}>{'  \u2193 more'}</Text>}
          </Box>
        </Box>
      </Box>

      <Box flexGrow={1} />

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{'\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Esc cancel'}</Text>
      </Box>
    </Box>
  );
}
