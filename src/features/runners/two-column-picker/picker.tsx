import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { ListRow } from '../../../components/list-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
import type { FilterableItem } from '../../../components/pickers/filtering.js';
import { availableRows } from '../../../components/pickers/scroll-window.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { pickerPanelWidth } from '../panel-width.js';
import { useStores } from '../../../stores/use-stores.js';
import { SingleColumnPicker } from '../../../components/pickers/single-column.js';
import { ROW_ZONE_Z_OVERLAY } from '../../../components/pickers/row-zone.js';
import { useTwoColumnState, type LeftColumnProps, type RightColumnProps } from './use-nav-state.js';
import {
  CUSTOM_ROW_ID,
  isRealRightItem,
  isVirtualCustomItem,
  type RightItemOrVirtual,
} from './virtual-items.js';

export interface PreviewContext<L, R> {
  activeColumn: 'left' | 'right';
  leftItem: L | undefined;
  rightItem: R | null;
  isOnCustomItem: boolean;
  isOnLeftCustomItem: boolean;
}

export interface TwoColumnPickerProps<L extends FilterableItem, R extends { id: string }> {
  title: string;
  subtitle?: string | undefined;
  stepLabel?: string | undefined;
  initialColumn?: 'left' | 'right' | undefined;
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
  /** Enter on a disabled left row; without it that keypress stays a no-op. */
  onDisabledSelect?: ((item: L) => void) | undefined;
  preview?: ((ctx: PreviewContext<L, R>) => string | undefined) | undefined;
}

const PREVIEW_MIN_COLS = 50;

const INNER_PADDING = 4;
const COLUMN_GAP = 3;

function getHint(
  nav: { isOnCustomItem: boolean; isOnLeftCustomItem: boolean; currentRightIsCustom: boolean },
  hasRefresh: boolean,
  maxVisible: number,
): string {
  if (maxVisible <= 0) {
    return `Terminal too short${SOFT_SEP}esc cancel`;
  }
  const refreshHint = hasRefresh ? `${SOFT_SEP}ctrl+r refresh` : '';
  if (nav.isOnLeftCustomItem) {
    return `←→ column${SOFT_SEP}⏎ add custom${SOFT_SEP}esc cancel${refreshHint}`;
  }
  if (nav.isOnCustomItem) {
    return `←→ column${SOFT_SEP}↑↓ select${SOFT_SEP}⏎ add custom${SOFT_SEP}esc cancel${refreshHint}`;
  }
  if (nav.currentRightIsCustom) {
    return `←→ column${SOFT_SEP}↑↓ select${SOFT_SEP}⏎ confirm${SOFT_SEP}ctrl+d delete${SOFT_SEP}esc cancel${refreshHint}`;
  }
  return `←→ column${SOFT_SEP}↑↓ select${SOFT_SEP}⏎ confirm${SOFT_SEP}esc cancel${refreshHint}`;
}

export function TwoColumnPicker<L extends FilterableItem, R extends { id: string }>({
  title,
  subtitle,
  stepLabel,
  initialColumn = 'left',
  leftProps,
  rightProps,
  onConfirm,
  onCancel,
  onRefresh,
  onDisabledSelect,
  preview,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);

  const outerChrome = 6;
  const innerChrome = 4;
  const maxVisible = Math.min(availableRows({ rows, chromeRows: outerChrome + innerChrome }), 20);
  const columnHeight = maxVisible + 4;
  const totalBoxWidth = pickerPanelWidth(cols, isSmall);
  const columnContentWidth = Math.max(
    1,
    Math.floor((totalBoxWidth - COLUMN_GAP) / 2) - INNER_PADDING,
  );

  const nav = useTwoColumnState<L, R>({
    leftProps,
    rightProps,
    initialColumn,
    onConfirm,
    onCancel,
    onRefresh,
    onDisabledSelect,
    maxVisible,
  });

  const hideRightFilter = nav.isSpecial;
  const rightItems = nav.isOnLeftCustomItem ? [] : nav.right.items;
  const placeholderNode =
    nav.isOnLeftCustomItem && leftProps.specialHelp
      ? leftProps.specialHelp
      : rightProps.placeholder;
  const hint = getHint(nav, !!onRefresh, maxVisible);

  const rightCurrent = nav.right.currentItem;
  const rawPreview = preview?.({
    activeColumn: nav.activeColumn,
    leftItem: nav.left.currentItem,
    rightItem: rightCurrent && isRealRightItem(rightCurrent) ? rightCurrent : null,
    isOnCustomItem: nav.isOnCustomItem,
    isOnLeftCustomItem: nav.isOnLeftCustomItem,
  });
  const previewText =
    rawPreview === undefined ? undefined : sanitizeTerminalDisplayText(rawPreview);
  const showPreview = previewText !== undefined && previewText !== '' && cols > PREVIEW_MIN_COLS;
  const leftEmptyText = `No ${(leftProps.label ?? 'items').toLowerCase()} match`;

  return (
    <Box
      width={cols}
      height={rows}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <Box width={totalBoxWidth} marginBottom={1} justifyContent="space-between">
        <Box>
          <Text color={t.accent}>{title}</Text>
          {subtitle ? <Text color={t.textDim}>{`${SOFT_SEP}${subtitle}`}</Text> : null}
        </Box>
        {stepLabel ? <Text color={t.textDim}>{stepLabel}</Text> : null}
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
          emptyText={leftEmptyText}
          onRowActivate={nav.activateLeft}
          rowZonePrefix="runner-left"
          rowZoneZ={ROW_ZONE_Z_OVERLAY}
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
          onRowActivate={nav.activateRight}
          rowZonePrefix="runner-right"
          rowZoneZ={ROW_ZONE_Z_OVERLAY}
          renderRow={(item, isCursor, maxWidth) => {
            if (isVirtualCustomItem(item)) {
              return (
                <ListRow
                  label="+ Add custom model…"
                  state={isCursor ? 'active' : 'default'}
                  defaultLead="dot"
                  width={maxWidth}
                />
              );
            }
            return rightProps.renderRow(item, { isCursor, maxWidth });
          }}
        />
      </Box>
      {showPreview ? (
        <Box width={totalBoxWidth} marginTop={1}>
          <Text color={t.textDim} wrap="truncate-end">
            {previewText}
          </Text>
        </Box>
      ) : null}
      <Box width={totalBoxWidth} marginTop={1}>
        <Text color={t.textDim}>{hint}</Text>
      </Box>
    </Box>
  );
}
