import { useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../ui/theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { computeScrollOffset } from '../ui/picker-utils.js';
import { SingleColumnPicker } from './single-column-picker.js';

type FilterableItem = { id: string; displayName: string };

export const CUSTOM_ROW_ID = '__custom__' as const;
export type VirtualCustomItem = { id: typeof CUSTOM_ROW_ID; isVirtual: true };
export type RightItemOrVirtual<R> = R | VirtualCustomItem;

export function isVirtualCustomItem<R extends { id: string }>(item: RightItemOrVirtual<R>): item is VirtualCustomItem {
  return 'isVirtual' in item && (item as VirtualCustomItem).isVirtual === true;
}

function defaultLeftFilter<L extends FilterableItem>(item: L, query: string): boolean {
  const lower = query.toLowerCase();
  return item.id.toLowerCase().includes(lower) || item.displayName.toLowerCase().includes(lower);
}

function defaultRightFilter<R extends { id: string }>(item: R, query: string): boolean {
  return item.id.toLowerCase().includes(query.toLowerCase());
}

export interface TwoColumnPickerProps<L, R> {
  title: string;
  leftItems: L[];
  rightItems: R[];
  leftRenderRow: (item: L, isCursor: boolean, isSelected: boolean, maxWidth: number) => ReactNode;
  rightRenderRow: (item: R, isCursor: boolean, maxWidth: number) => ReactNode;
  leftGetKey: (item: L) => string;
  rightGetKey: (item: R) => string;
  leftFilterFn?: (item: L, query: string) => boolean;
  rightFilterFn?: (item: R, query: string) => boolean;
  onLeftChange: (item: L) => void;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  rightPlaceholder?: ReactNode;
  leftLabel?: string;
  rightLabel?: string;
  stepLabel?: string;
  isLeftItemSpecial?: (item: L) => boolean;
  isLeftItemDisabled?: (item: L) => boolean;
  initialColumn?: 'left' | 'right';
  allowCustomRight?: boolean;
  onCustomRightOverlay?: (left: L) => void;
  onDeleteRight?: (item: R) => void;
  isRightItemCustom?: (item: R) => boolean;
  customLeftHelp?: ReactNode;
  initialLeftIndex?: number;
}

export function TwoColumnPicker<L extends FilterableItem, R extends { id: string }>({
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
  leftLabel = 'Tools',
  rightLabel = 'Models',
  stepLabel,
  isLeftItemSpecial,
  isLeftItemDisabled,
  initialColumn = 'left',
  allowCustomRight,
  onCustomRightOverlay,
  onDeleteRight,
  isRightItemCustom,
  customLeftHelp,
  initialLeftIndex,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const contentMaxWidth = isSmall ? 76 : 110;
  const columnHeight = Math.min(Math.floor(rows * 0.6), 22);
  const maxVisible = Math.max(columnHeight - 6, 3);

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>(initialColumn);
  const [leftIndex, setLeftIndex] = useState(initialLeftIndex ?? 0);
  const [rightIndex, setRightIndex] = useState(0);
  const [leftFilter, setLeftFilter] = useState('');
  const [rightFilter, setRightFilter] = useState('');
  const [selectedLeftKey, setSelectedLeftKey] = useState<string | null>(null);

  const filteredLeft = leftFilter
    ? leftItems.filter((item) => (leftFilterFn ?? defaultLeftFilter)(item, leftFilter))
    : leftItems;

  const realRight = rightFilter
    ? rightItems.filter((item) => (rightFilterFn ?? defaultRightFilter)(item, rightFilter))
    : rightItems;

  const filteredRight: RightItemOrVirtual<R>[] = allowCustomRight
    ? [{ id: CUSTOM_ROW_ID, isVirtual: true } as VirtualCustomItem, ...realRight]
    : realRight;

  const effectiveLeftIndex = Math.min(leftIndex, Math.max(0, filteredLeft.length - 1));
  const effectiveRightIndex = Math.min(rightIndex, Math.max(0, filteredRight.length - 1));
  const currentLeftItem = filteredLeft[effectiveLeftIndex];
  const isSpecial = currentLeftItem ? (isLeftItemSpecial?.(currentLeftItem) ?? false) : false;
  const isDisabled = currentLeftItem ? (isLeftItemDisabled?.(currentLeftItem) ?? false) : false;

  const leftScrollOffset = computeScrollOffset(effectiveLeftIndex, maxVisible, filteredLeft.length);
  const rightScrollOffset = computeScrollOffset(effectiveRightIndex, maxVisible, filteredRight.length);

  function findNextEnabled(from: number, direction: 1 | -1): number {
    if (filteredLeft.length === 0) return from;
    if (!isLeftItemDisabled) return (from + direction + filteredLeft.length) % filteredLeft.length;
    let next = (from + direction + filteredLeft.length) % filteredLeft.length;
    let steps = 0;
    while (isLeftItemDisabled(filteredLeft[next]) && steps < filteredLeft.length) {
      next = (next + direction + filteredLeft.length) % filteredLeft.length;
      steps++;
    }
    return steps >= filteredLeft.length ? from : next;
  }

  const totalBoxWidth = Math.min(cols - 4, contentMaxWidth);
  const columnContentWidth = Math.floor((totalBoxWidth - 3) / 2) - 2 - 4 - 2;

  const leftActive = activeColumn === 'left';
  const rightActive = activeColumn === 'right';

  const currentRightItem = filteredRight[effectiveRightIndex];
  const isOnVirtualCustomItem = currentRightItem && isVirtualCustomItem(currentRightItem);
  const isOnCustomItem = rightActive && isOnVirtualCustomItem;
  const isOnLeftCustomItem = leftActive && isSpecial;

  const currentRightIsCustom = (() => {
    if (!rightActive || !isRightItemCustom || !currentRightItem) return false;
    if (isVirtualCustomItem(currentRightItem)) return false;
    return isRightItemCustom(currentRightItem);
  })();

  function handleEscape() {
    onCancel();
  }

  function handleDelete() {
    if (activeColumn !== 'right' || !onDeleteRight) return;
    const item = filteredRight[effectiveRightIndex];
    if (item && !isVirtualCustomItem(item) && isRightItemCustom?.(item)) {
      onDeleteRight(item);
    }
  }

  function handleColumnLeft() {
    if (activeColumn === 'right') {
      setActiveColumn('left');
      setSelectedLeftKey(null);
    }
  }

  function handleColumnRight() {
    if (activeColumn !== 'left') return;
    if (!currentLeftItem || isDisabled) return;
    if (isSpecial) return;
    if (rightItems.length > 0 || rightPlaceholder) {
      setActiveColumn('right');
    }
  }

  function handleVerticalNav(direction: 'up' | 'down') {
    if (activeColumn === 'left') {
      if (filteredLeft.length === 0) return;
      const delta = direction === 'up' ? -1 : 1;
      const next = findNextEnabled(effectiveLeftIndex, delta);
      setLeftIndex(next);
      if (filteredLeft[next]) {
        onLeftChange(filteredLeft[next]);
        setRightIndex(0);
        setRightFilter('');
      }
      return;
    }
    if (filteredRight.length === 0) return;
    if (direction === 'up') {
      setRightIndex(effectiveRightIndex > 0 ? effectiveRightIndex - 1 : filteredRight.length - 1);
    } else {
      setRightIndex(effectiveRightIndex < filteredRight.length - 1 ? effectiveRightIndex + 1 : 0);
    }
  }

  function handleReturn() {
    if (activeColumn === 'left') {
      if (!currentLeftItem || isDisabled) return;
      if (isSpecial) {
        onConfirm(currentLeftItem, null);
        return;
      }
      setSelectedLeftKey(leftGetKey(currentLeftItem));
      if (rightItems.length > 0 || rightPlaceholder) {
        setActiveColumn('right');
      }
      return;
    }
    const rightCurrent = filteredRight[effectiveRightIndex];
    if (rightCurrent && isVirtualCustomItem(rightCurrent) && onCustomRightOverlay && currentLeftItem) {
      onCustomRightOverlay(currentLeftItem);
      return;
    }
    const leftItem = filteredLeft[effectiveLeftIndex];
    const rightItem = rightCurrent && !isVirtualCustomItem(rightCurrent) ? rightCurrent : null;
    if (leftItem) onConfirm(leftItem, rightItem);
  }

  function handleBackspace() {
    if (activeColumn === 'left') {
      if (!isSpecial) {
        setLeftFilter(leftFilter.slice(0, -1));
        setLeftIndex(0);
      }
    } else {
      setRightFilter(rightFilter.slice(0, -1));
      setRightIndex(0);
    }
  }

  function handleCharInput(input: string) {
    if (activeColumn === 'left') {
      if (!isSpecial) {
        setLeftFilter(leftFilter + input);
        setLeftIndex(0);
      }
    } else {
      setRightFilter(rightFilter + input);
      setRightIndex(0);
    }
  }

  useInput((input, key) => {
    if (key.escape) return handleEscape();
    if (key.ctrl && input === 'd') return handleDelete();
    if (key.leftArrow) return handleColumnLeft();
    if (key.rightArrow) return handleColumnRight();
    if (key.upArrow) return handleVerticalNav('up');
    if (key.downArrow) return handleVerticalNav('down');
    if (key.return) return handleReturn();
    if (key.backspace || key.delete) return handleBackspace();
    if (input && !key.ctrl && !key.meta) return handleCharInput(input);
  }, { isActive: true });

  const displayTitle = stepLabel ? `${title} \u2014 ${stepLabel}` : title;

  const rightHideFilterRow = isSpecial || isOnLeftCustomItem;

  const rightCustomFilterPrompt = isOnCustomItem && !rightFilter
    ? <Text color={t.textDim}>Press Enter to add custom...</Text>
    : undefined;

  const rightPlaceholderNode = isOnLeftCustomItem && customLeftHelp
    ? customLeftHelp
    : (rightPlaceholder ?? (
      <Box flexDirection="column">
        <Text color={t.textDim}>No models detected</Text>
        <Text color={t.textDim} dimColor>Start a provider to see models:</Text>
        <Text color={t.textDim} dimColor>  ollama serve</Text>
      </Box>
    ));

  const rightFooter = isOnCustomItem ? (
    <Box marginTop={1}>
      <Text color={t.textDim} dimColor>
        Press Enter to add a custom model
      </Text>
    </Box>
  ) : null;

  const rightItemsForPicker: RightItemOrVirtual<R>[] = isOnLeftCustomItem ? [] : filteredRight;

  return (
    <Box width={cols} height={rows} flexDirection="column" alignItems="center" justifyContent="center">
      <Box justifyContent="center" marginBottom={2}>
        <Text bold color={t.accent}>{displayTitle}</Text>
      </Box>

      <Box gap={3} width={totalBoxWidth} flexDirection="row">
        <SingleColumnPicker<L>
          label={leftLabel}
          items={filteredLeft}
          filter={leftFilter}
          selectedIndex={effectiveLeftIndex}
          isActive={leftActive}
          height={columnHeight}
          visibleRows={maxVisible}
          scrollOffset={leftScrollOffset}
          getKey={leftGetKey}
          contentMaxWidth={columnContentWidth}
          renderRow={(item, isCursor, maxWidth) => {
            const isSelected = selectedLeftKey === leftGetKey(item);
            return leftRenderRow(item, isCursor, isSelected, maxWidth);
          }}
        />

        <SingleColumnPicker<RightItemOrVirtual<R>>
          label={rightLabel}
          items={rightItemsForPicker}
          filter={rightFilter}
          selectedIndex={effectiveRightIndex}
          isActive={rightActive}
          height={columnHeight}
          visibleRows={maxVisible}
          scrollOffset={rightScrollOffset}
          getKey={(item) => isVirtualCustomItem(item) ? CUSTOM_ROW_ID : rightGetKey(item)}
          contentMaxWidth={columnContentWidth}
          hideFilterRow={rightHideFilterRow}
          customFilterPrompt={rightCustomFilterPrompt}
          placeholderWhenEmpty={rightPlaceholderNode}
          footer={rightFooter}
          renderRow={(item, isCursor, maxWidth) => {
            if (isVirtualCustomItem(item)) {
              return (
                <Text color={isCursor ? t.accent : t.textDim} italic>
                  + Custom model...
                </Text>
              );
            }
            return rightRenderRow(item, isCursor, maxWidth);
          }}
        />
      </Box>

      <Box justifyContent="center" marginTop={2}>
        <Text color={t.textDim}>
          {isOnCustomItem
            ? '\u2190 back  Enter add custom  Esc cancel'
            : currentRightIsCustom
              ? '\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Ctrl+D delete  Esc cancel'
              : '\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}
