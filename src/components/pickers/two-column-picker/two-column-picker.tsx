import { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../ui/theme.js';
import { type FilterableItem } from '../../../ui/picker-utils.js';
import { useResponsiveLayout } from '../../../hooks/use-terminal-size.js';
import { SingleColumnPicker } from '../single-column-picker.js';
import {
  useTwoColumnState,
  CUSTOM_ROW_ID,
  isVirtualCustomItem,
  type RightItemOrVirtual,
} from './use-two-column-state.js';

export interface LeftColumnProps<L> {
  items: L[];
  label?: string | undefined;
  filterBy?: ((item: L, query: string) => boolean) | undefined;
  renderRow: (item: L, meta: { isCursor: boolean; isSelected: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: L) => string;
  isSpecial?: ((item: L) => boolean) | undefined;
  isDisabled?: ((item: L) => boolean) | undefined;
  initialIndex?: number | undefined;
  specialHelp?: ReactNode | undefined;
}

export interface CustomRowOptions<L, R> {
  onSelect: (left: L) => void;
  isCustom?: ((item: R) => boolean) | undefined;
  onDelete?: ((item: R) => void) | undefined;
}

export interface RightColumnProps<L, R> {
  items: R[];
  label?: string | undefined;
  filterBy?: ((item: R, query: string) => boolean) | undefined;
  renderRow: (item: R, meta: { isCursor: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: R) => string;
  placeholder?: ReactNode | undefined;
  customRow?: CustomRowOptions<L, R> | undefined;
  onLeftChange?: ((item: L) => void) | undefined;
}

export interface TwoColumnPickerProps<L extends FilterableItem, R extends { id: string }> {
  title: string;
  stepLabel?: string | undefined;
  initialColumn?: 'left' | 'right' | undefined;
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
}

const BORDER_WIDTH = 2;
const INNER_PADDING = 4;
const CURSOR_WIDTH = 2;
const COLUMN_GAP = 3;

export function TwoColumnPicker<L extends FilterableItem, R extends { id: string }>({
  title,
  stepLabel,
  initialColumn = 'left',
  leftProps,
  rightProps,
  onConfirm,
  onCancel,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const contentMaxWidth = isSmall ? 76 : 110;
  const columnHeight = Math.min(Math.floor(rows * 0.6), 22);
  const maxVisible = Math.max(columnHeight - 6, 3);
  const totalBoxWidth = Math.min(cols - 4, contentMaxWidth);
  const columnContentWidth =
    Math.floor((totalBoxWidth - COLUMN_GAP) / 2) - BORDER_WIDTH - INNER_PADDING - CURSOR_WIDTH;

  const nav = useTwoColumnState<L, R>({
    leftItems: leftProps.items,
    rightItems: rightProps.items,
    leftGetKey: leftProps.getKey,
    leftFilterFn: leftProps.filterBy,
    rightFilterFn: rightProps.filterBy,
    isLeftItemSpecial: leftProps.isSpecial,
    isLeftItemDisabled: leftProps.isDisabled,
    isRightItemCustom: rightProps.customRow?.isCustom,
    initialColumn,
    initialLeftIndex: leftProps.initialIndex,
    allowCustomRight: !!rightProps.customRow,
    rightPlaceholder: rightProps.placeholder,
    onLeftChange: rightProps.onLeftChange ?? (() => {}),
    onConfirm,
    onCancel,
    onCustomRightOverlay: rightProps.customRow?.onSelect,
    onDeleteRight: rightProps.customRow?.onDelete,
  });

  const displayTitle = stepLabel ? `${title} \u2014 ${stepLabel}` : title;
  const hideFilterRow = nav.isSpecial || nav.isOnLeftCustomItem;
  const rightItems = nav.isOnLeftCustomItem ? [] : nav.right.items;
  const placeholderNode = nav.isOnLeftCustomItem && leftProps.specialHelp ? leftProps.specialHelp : rightProps.placeholder;
  const hint = nav.isOnCustomItem
    ? '\u2190 back  Enter add custom  Esc cancel'
    : nav.currentRightIsCustom
      ? '\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Ctrl+D delete  Esc cancel'
      : '\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Esc cancel';

  return (
    <Box width={cols} height={rows} flexDirection="column" alignItems="center" justifyContent="center">
      <Box justifyContent="center" marginBottom={2}>
        <Text bold color={t.accent}>{displayTitle}</Text>
      </Box>
      <Box gap={COLUMN_GAP} width={totalBoxWidth} flexDirection="row">
        <SingleColumnPicker<L>
          label={leftProps.label ?? 'Items'}
          items={nav.left.items}
          filter={nav.left.filter}
          selectedIndex={nav.left.index}
          isActive={nav.activeColumn === 'left'}
          height={columnHeight}
          visibleRows={maxVisible}
          getKey={leftProps.getKey}
          contentMaxWidth={columnContentWidth}
          hideFilterRow={hideFilterRow}
          renderRow={(item, isCursor, maxWidth) =>
            leftProps.renderRow(item, {
              isCursor,
              isSelected: nav.selectedLeftKey === leftProps.getKey(item),
              maxWidth,
            })
          }
        />
        <SingleColumnPicker<RightItemOrVirtual<R>>
          label={rightProps.label ?? 'Options'}
          items={rightItems}
          filter={nav.right.filter}
          selectedIndex={nav.right.index}
          isActive={nav.activeColumn === 'right'}
          height={columnHeight}
          visibleRows={maxVisible}
          getKey={(item) => (isVirtualCustomItem(item) ? CUSTOM_ROW_ID : rightProps.getKey(item))}
          contentMaxWidth={columnContentWidth}
          hideFilterRow={hideFilterRow}
          customFilterPrompt={nav.isOnCustomItem && !nav.right.filter
            ? <Text color={t.textDim}>Press Enter to add custom...</Text>
            : undefined}
          placeholderWhenEmpty={placeholderNode}
          footer={nav.isOnCustomItem ? (
            <Box marginTop={1}>
              <Text color={t.textDim} dimColor>Press Enter to add a custom model</Text>
            </Box>
          ) : null}
          renderRow={(item, isCursor, maxWidth) => {
            if (isVirtualCustomItem(item)) {
              return <Text color={isCursor ? t.accent : t.textDim} italic>+ Custom model...</Text>;
            }
            return rightProps.renderRow(item, { isCursor, maxWidth });
          }}
        />
      </Box>
      <Box justifyContent="center" marginTop={2}>
        <Text color={t.textDim}>{hint}</Text>
      </Box>
    </Box>
  );
}
