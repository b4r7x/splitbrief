import { Box, Text } from 'ink';
import { useTheme } from '../../../ui/theme.js';
import { type FilterableItem } from '../picker-utils.js';
import { getResponsivePanelWidth, terminalSizeStore } from '../../../stores/terminal-size.js';
import { SingleColumnPicker } from '../single-column-picker.js';
import {
  useTwoColumnState,
  CUSTOM_ROW_ID,
  isVirtualCustomItem,
  type LeftColumnProps,
  type RightColumnProps,
  type RightItemOrVirtual,
} from './use-two-column-state.js';

export type { LeftColumnProps, RightColumnProps, CustomRowOptions } from './use-two-column-state.js';

export interface TwoColumnPickerProps<L extends FilterableItem, R extends { id: string }> {
  title: string;
  stepLabel?: string | undefined;
  initialColumn?: 'left' | 'right' | undefined;
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
}

const BORDER_WIDTH = 2;
const INNER_PADDING = 4;
const CURSOR_WIDTH = 2;
const COLUMN_GAP = 3;

function getHint(nav: { isOnCustomItem: boolean; currentRightIsCustom: boolean }, hasRefresh: boolean): string {
  const refreshHint = hasRefresh ? '  Ctrl+R refresh' : '';
  if (nav.isOnCustomItem) {
    return `\u2190 back  Enter add custom  Esc cancel${refreshHint}`;
  }
  if (nav.currentRightIsCustom) {
    return `\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Ctrl+D delete  Esc cancel${refreshHint}`;
  }
  return `\u2190\u2192 column  \u2191\u2193 select  Enter confirm  Esc cancel${refreshHint}`;
}

export function TwoColumnPicker<L extends FilterableItem, R extends { id: string }>({
  title,
  stepLabel,
  initialColumn = 'left',
  leftProps,
  rightProps,
  onConfirm,
  onCancel,
  onRefresh,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const { cols, rows, isSmall } = terminalSizeStore.use(s => s);

  const contentMaxWidth = isSmall ? 76 : 110;
  const outerChrome = 6; // title(1) + marginBottom(2) + hint(1) + marginTop(2)
  const innerChrome = 6; // border(2) + label(1) + filter(1) + scrollUp(1) + scrollDown(1)
  const maxVisible = Math.min(Math.max(rows - outerChrome - innerChrome, 3), 20);
  const columnHeight = maxVisible + innerChrome;
  const totalBoxWidth = getResponsivePanelWidth(cols, isSmall, { small: contentMaxWidth, large: contentMaxWidth });
  const columnContentWidth = Math.max(
    1,
    Math.floor((totalBoxWidth - COLUMN_GAP) / 2) - BORDER_WIDTH - INNER_PADDING - CURSOR_WIDTH,
  );

  const nav = useTwoColumnState<L, R>({
    leftProps,
    rightProps,
    initialColumn,
    onConfirm,
    onCancel,
    onRefresh,
  });

  const displayTitle = stepLabel ? `${title} \u2014 ${stepLabel}` : title;
  const hideRightFilter = nav.isSpecial;
  const rightItems = nav.isOnLeftCustomItem ? [] : nav.right.items;
  const placeholderNode = nav.isOnLeftCustomItem && leftProps.specialHelp ? leftProps.specialHelp : rightProps.placeholder;
  const hint = getHint(nav, !!onRefresh);

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
          hideFilterRow={false}
          renderRow={(item, isCursor, maxWidth) => {
            const key = leftProps.getKey(item);
            const isSelected = nav.selectedLeftKey
              ? nav.selectedLeftKey === key
              : !!('isCurrent' in item && item.isCurrent);
            return leftProps.renderRow(item, { isCursor, isSelected, maxWidth });
          }}
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
          hideFilterRow={hideRightFilter}
          placeholderWhenEmpty={placeholderNode}
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
