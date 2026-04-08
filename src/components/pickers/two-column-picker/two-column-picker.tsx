import { type ReactNode, Children, isValidElement } from 'react';
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
import { TwoColumnPickerContext, useTwoColumnPickerCtx, type TwoColumnLayout } from './two-column-picker-context.js';

export interface LeftColumnProps<L> {
  items: L[];
  label?: string;
  filterBy?: (item: L, query: string) => boolean;
  renderRow: (item: L, meta: { isCursor: boolean; isSelected: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: L) => string;
  isSpecial?: (item: L) => boolean;
  isDisabled?: (item: L) => boolean;
  initialIndex?: number;
  specialHelp?: ReactNode;
}

export interface CustomRowOptions<L, R> {
  onSelect: (left: L) => void;
  isCustom?: (item: R) => boolean;
  onDelete?: (item: R) => void;
}

export interface RightColumnProps<L, R> {
  items: R[];
  label?: string;
  filterBy?: (item: R, query: string) => boolean;
  renderRow: (item: R, meta: { isCursor: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: R) => string;
  placeholder?: ReactNode;
  customRow?: CustomRowOptions<L, R>;
  onLeftChange?: (item: L) => void;
}

export interface TwoColumnPickerProps<L extends FilterableItem, R extends { id: string }> {
  title: string;
  stepLabel?: string;
  initialColumn?: 'left' | 'right';
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  children: ReactNode;
}

const BORDER_WIDTH = 2;
const INNER_PADDING = 4;
const CURSOR_WIDTH = 2;
const COLUMN_GAP = 3;

function extractColumnProps<L extends FilterableItem, R extends { id: string }>(
  children: ReactNode,
): { leftProps: LeftColumnProps<L> | null; rightProps: RightColumnProps<L, R> | null } {
  let leftProps: LeftColumnProps<L> | null = null;
  let rightProps: RightColumnProps<L, R> | null = null;

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === TwoColumnPicker.Left) {
      leftProps = child.props as LeftColumnProps<L>;
    } else if (child.type === TwoColumnPicker.Right) {
      rightProps = child.props as RightColumnProps<L, R>;
    } else if (child.type === TwoColumnPicker.Columns) {
      const inner = extractColumnProps<L, R>((child.props as { children?: ReactNode }).children);
      if (inner.leftProps) leftProps = inner.leftProps;
      if (inner.rightProps) rightProps = inner.rightProps;
    }
  });

  return { leftProps, rightProps };
}

export function TwoColumnPicker<L extends FilterableItem, R extends { id: string }>({
  title,
  stepLabel,
  initialColumn = 'left',
  onConfirm,
  onCancel,
  children,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const contentMaxWidth = isSmall ? 76 : 110;
  const columnHeight = Math.min(Math.floor(rows * 0.6), 22);
  const maxVisible = Math.max(columnHeight - 6, 3);
  const totalBoxWidth = Math.min(cols - 4, contentMaxWidth);
  const columnContentWidth =
    Math.floor((totalBoxWidth - COLUMN_GAP) / 2) - BORDER_WIDTH - INNER_PADDING - CURSOR_WIDTH;
  const layout: TwoColumnLayout = { cols, rows, totalBoxWidth, columnContentWidth, columnHeight, maxVisible };

  const { leftProps, rightProps } = extractColumnProps<L, R>(children);

  if (!leftProps || !rightProps) {
    throw new Error('<TwoColumnPicker> requires both a <TwoColumnPicker.Left> and <TwoColumnPicker.Right> child');
  }

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

  const ctx = {
    nav,
    layout,
    leftGetKey: leftProps.getKey,
    rightGetKey: rightProps.getKey,
    selectedLeftKey: nav.selectedLeftKey,
    specialHelp: leftProps.specialHelp,
    onConfirm,
    onCancel,
  };

  const displayTitle = stepLabel ? `${title} \u2014 ${stepLabel}` : title;

  return (
    <TwoColumnPickerContext.Provider value={ctx}>
      <Box width={layout.cols} height={layout.rows} flexDirection="column" alignItems="center" justifyContent="center">
        <Box justifyContent="center" marginBottom={2}>
          <Text bold color={t.accent}>{displayTitle}</Text>
        </Box>
        {children}
      </Box>
    </TwoColumnPickerContext.Provider>
  );
}

function Columns({ children }: { children: ReactNode }) {
  const { layout } = useTwoColumnPickerCtx();
  return (
    <Box gap={3} width={layout.totalBoxWidth} flexDirection="row">
      {children}
    </Box>
  );
}

function Left<L extends FilterableItem>(props: LeftColumnProps<L>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { nav, layout, leftGetKey, selectedLeftKey } = useTwoColumnPickerCtx<L, any>();
  const { columnHeight, columnContentWidth, maxVisible } = layout;
  const leftActive = nav.activeColumn === 'left';

  return (
    <SingleColumnPicker<L>
      label={props.label ?? 'Items'}
      items={nav.left.items}
      filter={nav.left.filter}
      selectedIndex={nav.left.index}
      isActive={leftActive}
      height={columnHeight}
      visibleRows={maxVisible}
      getKey={leftGetKey}
      contentMaxWidth={columnContentWidth}
      hideFilterRow={nav.isSpecial || nav.isOnLeftCustomItem}
      renderRow={(item, isCursor, maxWidth) =>
        props.renderRow(item, {
          isCursor,
          isSelected: selectedLeftKey === leftGetKey(item),
          maxWidth,
        })
      }
    />
  );
}

function Right<L extends FilterableItem, R extends { id: string }>(props: RightColumnProps<L, R>) {
  const { nav, layout, rightGetKey, specialHelp } = useTwoColumnPickerCtx<L, R>();
  const t = useTheme();
  const { columnHeight, columnContentWidth, maxVisible } = layout;
  const rightActive = nav.activeColumn === 'right';

  const items = nav.isOnLeftCustomItem ? [] : nav.right.items;
  const hideFilterRow = nav.isSpecial || nav.isOnLeftCustomItem;
  const customFilterPrompt = nav.isOnCustomItem && !nav.right.filter;
  const placeholderNode = nav.isOnLeftCustomItem && specialHelp ? specialHelp : props.placeholder;
  const showFooter = nav.isOnCustomItem;

  return (
    <SingleColumnPicker<RightItemOrVirtual<R>>
      label={props.label ?? 'Options'}
      items={items}
      filter={nav.right.filter}
      selectedIndex={nav.right.index}
      isActive={rightActive}
      height={columnHeight}
      visibleRows={maxVisible}
      getKey={(item) => isVirtualCustomItem(item) ? CUSTOM_ROW_ID : rightGetKey(item)}
      contentMaxWidth={columnContentWidth}
      hideFilterRow={hideFilterRow}
      customFilterPrompt={customFilterPrompt
        ? <Text color={t.textDim}>Press Enter to add custom...</Text>
        : undefined}
      placeholderWhenEmpty={placeholderNode}
      footer={showFooter ? (
        <Box marginTop={1}>
          <Text color={t.textDim} dimColor>Press Enter to add a custom model</Text>
        </Box>
      ) : null}
      renderRow={(item, isCursor, maxWidth) => {
        if (isVirtualCustomItem(item)) {
          return (
            <Text color={isCursor ? t.accent : t.textDim} italic>
              + Custom model...
            </Text>
          );
        }
        return props.renderRow(item, { isCursor, maxWidth });
      }}
    />
  );
}

function Hint() {
  const { nav } = useTwoColumnPickerCtx();
  const t = useTheme();

  const hint = nav.isOnCustomItem
    ? '\u2190 back  Enter add custom  Esc cancel'
    : nav.currentRightIsCustom
      ? '\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Ctrl+D delete  Esc cancel'
      : '\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Esc cancel';

  return (
    <Box justifyContent="center" marginTop={2}>
      <Text color={t.textDim}>{hint}</Text>
    </Box>
  );
}

TwoColumnPicker.Left = Left as <L extends FilterableItem>(props: LeftColumnProps<L>) => ReactNode;
TwoColumnPicker.Right = Right as <L extends FilterableItem, R extends { id: string }>(props: RightColumnProps<L, R>) => ReactNode;
TwoColumnPicker.Columns = Columns;
TwoColumnPicker.Hint = Hint;
