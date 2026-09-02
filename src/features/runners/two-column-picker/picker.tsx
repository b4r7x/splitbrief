import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { ListRow } from '../../../components/list-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
import type { FilterableItem } from '../../../components/pickers/filtering.js';
import { availableRows } from '../../../components/pickers/scroll-window.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { overlayWidth } from '../../../core/navigation/overlay-rect.js';
import { useStores } from '../../../stores/use-stores.js';
import { SingleColumnPicker } from '../../../components/pickers/single-column.js';
import { ROW_ZONE_Z_OVERLAY } from '../../../components/pickers/row-zone.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import type {
  LeftColumnProps,
  RightColumnProps,
  RightSectionProps,
  TerminalPane,
} from './types.js';
import { useTwoColumnState } from './use-nav-state.js';
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
  preview?: ((ctx: PreviewContext<L, R>) => string | undefined) | undefined;
}

const PREVIEW_MIN_COLS = 50;

const INNER_PADDING = 4;
/** Below this card width the instruction line truncates instead of wrapping. */
const CARD_WRAP_MIN_WIDTH = 40;
const COLUMN_GAP = 3;
const OUTER_CHROME_ROWS = 6;
const INNER_CHROME_ROWS = 4;
const VISIBLE_ROWS_CAP = 18;

type PickerHintKind = 'terminal' | 'expanded' | 'default';

function getHint(input: {
  kind: PickerHintKind;
  terminalVerb: string | undefined;
  nav: { isOnCustomItem: boolean; currentRightIsCustom: boolean };
  hasRefresh: boolean;
  maxVisible: number;
  expandedHint?: string | undefined;
}): string {
  const { kind, nav, hasRefresh, maxVisible } = input;
  if (maxVisible <= 0) {
    return `Terminal too short${SOFT_SEP}esc cancel`;
  }
  const refreshHint = hasRefresh ? `${SOFT_SEP}ctrl+r refresh` : '';
  if (kind === 'terminal') {
    const verb = input.terminalVerb ?? 'select';
    return `↑↓ select${SOFT_SEP}⏎ ${verb}${SOFT_SEP}esc cancel${refreshHint}`;
  }
  if (kind === 'expanded') {
    // The launcher is pinned above the expansion and answers for itself, so the
    // expansion's verb never speaks for it.
    const lead = nav.isOnCustomItem ? '⏎ add custom' : (input.expandedHint ?? '⏎ choose route');
    // An empty lead is a row with no verb of its own; it drops its slot rather
    // than opening the line with a separator that reads as a missing key.
    const parts = [lead, 'esc collapse', '←→ column', '↑↓ select'].filter((part) => part !== '');
    return `${parts.join(SOFT_SEP)}${refreshHint}`;
  }
  if (nav.isOnCustomItem) {
    return `←→ column${SOFT_SEP}↑↓ select${SOFT_SEP}⏎ add custom${SOFT_SEP}esc cancel${refreshHint}`;
  }
  if (nav.currentRightIsCustom) {
    return `←→ column${SOFT_SEP}↑↓ select${SOFT_SEP}⏎ confirm${SOFT_SEP}ctrl+d delete${SOFT_SEP}esc cancel${refreshHint}`;
  }
  return `←→ column${SOFT_SEP}↑↓ select${SOFT_SEP}⏎ confirm${SOFT_SEP}esc cancel${refreshHint}`;
}

/**
 * The read-only pane a terminal left row opens: fixed height matching
 * columnHeight so the right box never collapses.
 */
function TerminalPaneCard({
  pane,
  contentWidth,
  height,
}: {
  pane: TerminalPane;
  contentWidth: number;
  height: number;
}) {
  const t = useTheme();
  // Only the widest viewport has room to spend a second row on a wrapped
  // sentence; below it the card truncates so the box keeps its line count.
  const wrap = contentWidth >= CARD_WRAP_MIN_WIDTH ? 'wrap' : 'truncate-end';
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      height={height}
      borderStyle={borderStyleFor('round')}
      borderColor={t.border}
      borderDimColor
      paddingX={1}
    >
      <Text color={t.text}>{sanitizeTerminalDisplayText(pane.label)}</Text>
      <Box height={1} />
      {pane.lines.map((line, i) =>
        line === '' ? (
          <Box key={`blank-${i}`} height={1} />
        ) : (
          <Text key={`line-${i}`} color={t.textDim} wrap={wrap}>
            {sanitizeTerminalDisplayText(line)}
          </Text>
        ),
      )}
    </Box>
  );
}

type RightDisplaySlot<R> =
  | { kind: 'spacer'; key: string }
  | { kind: 'header'; key: string; section: string }
  | { kind: 'guidance'; key: string }
  | { kind: 'row'; key: string; item: RightItemOrVirtual<R>; navIndex: number };

export function buildRightDisplay<R extends { id: string }>(
  items: RightItemOrVirtual<R>[],
  getKey: (item: R) => string,
  section: RightSectionProps<R> | undefined,
): RightDisplaySlot<R>[] {
  const slots: RightDisplaySlot<R>[] = [];
  let previous: string | null = null;
  items.forEach((item, navIndex) => {
    const key = isVirtualCustomItem(item) ? CUSTOM_ROW_ID : getKey(item);
    if (section && isRealRightItem(item)) {
      const current = section.by(item);
      // A row that opens no section of its own — the children of an expansion —
      // leaves the open section standing, or the next row of it repeats its header.
      if (current !== '') {
        if (current !== previous && (section.headerFor?.(current) ?? true)) {
          if (slots.length > 0) {
            slots.push({ kind: 'spacer', key: `spacer:${current}` });
          }
          slots.push({ kind: 'header', key: `section:${current}`, section: current });
        }
        previous = current;
      }
    }
    slots.push({ kind: 'row', key, item, navIndex });
  });
  // The custom-model row is an affordance, not catalog content: with no real
  // row behind it the column still owes the reader why the catalog is empty.
  if (!items.some(isRealRightItem)) slots.push({ kind: 'guidance', key: 'guidance' });
  return slots;
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
  preview,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);

  const maxVisible = Math.min(
    availableRows({ rows, chromeRows: OUTER_CHROME_ROWS + INNER_CHROME_ROWS }),
    VISIBLE_ROWS_CAP,
  );
  const columnHeight = maxVisible + INNER_CHROME_ROWS;
  const totalBoxWidth = overlayWidth({ cols, density: 'wide' });
  // The odd cell goes to the Models column, which carries the longer strings.
  const leftBoxWidth = Math.floor((totalBoxWidth - COLUMN_GAP) / 2);
  const rightBoxWidth = totalBoxWidth - COLUMN_GAP - leftBoxWidth;
  const leftContentWidth = Math.max(1, leftBoxWidth - INNER_PADDING);
  const rightContentWidth = Math.max(1, rightBoxWidth - INNER_PADDING);

  const nav = useTwoColumnState<L, R>({
    leftProps,
    rightProps,
    initialColumn,
    onConfirm,
    onCancel,
    onRefresh,
    maxVisible,
  });

  const terminalPane = nav.terminalPane;
  const display = buildRightDisplay<R>(nav.right.items, rightProps.getKey, rightProps.section);
  const selectedDisplayIndex = Math.max(
    0,
    display.findIndex((slot) => slot.kind === 'row' && slot.navIndex === nav.right.index),
  );

  const rightCurrent = nav.right.currentItem;
  const hintKind: PickerHintKind =
    terminalPane !== undefined
      ? 'terminal'
      : rightProps.isExpanded && nav.activeColumn === 'right'
        ? 'expanded'
        : 'default';
  const hint = getHint({
    kind: hintKind,
    terminalVerb: terminalPane?.verb,
    nav,
    hasRefresh: !!onRefresh,
    maxVisible,
    expandedHint: rightProps.expandedHint?.(
      rightCurrent && isRealRightItem(rightCurrent) ? rightCurrent : undefined,
    ),
  });

  const rawPreview =
    terminalPane !== undefined
      ? undefined
      : preview?.({
          activeColumn: nav.activeColumn,
          leftItem: nav.left.currentItem,
          rightItem: rightCurrent && isRealRightItem(rightCurrent) ? rightCurrent : null,
          isOnCustomItem: nav.isOnCustomItem,
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
      <Box gap={COLUMN_GAP} width={totalBoxWidth} flexDirection="row" alignItems="flex-start">
        <Box width={leftBoxWidth} flexShrink={0}>
          <SingleColumnPicker<L>
            label={leftProps.label ?? 'Items'}
            items={nav.left.items}
            filter={nav.left.filter}
            selectedIndex={nav.left.index}
            isActive={nav.activeColumn === 'left'}
            height={columnHeight}
            visibleRows={maxVisible}
            getKey={leftProps.getKey}
            contentMaxWidth={leftContentWidth}
            emptyText={leftEmptyText}
            onRowActivate={nav.activateLeft}
            rowZonePrefix="runner-left"
            rowZoneZ={ROW_ZONE_Z_OVERLAY}
            renderRow={(item, isCursor, maxWidth) => {
              const key = leftProps.getKey(item);
              const isSelected = nav.selectedLeftKey
                ? nav.selectedLeftKey === key
                : !!('isCurrent' in item && item.isCurrent);
              const isContext =
                nav.activeColumn === 'right' &&
                nav.left.currentItem !== undefined &&
                leftProps.getKey(item) === leftProps.getKey(nav.left.currentItem);
              return leftProps.renderRow(item, { isCursor, isSelected, isContext, maxWidth });
            }}
          />
        </Box>
        <Box width={rightBoxWidth} flexShrink={0}>
          {terminalPane !== undefined ? (
            <TerminalPaneCard
              pane={terminalPane}
              contentWidth={rightContentWidth}
              height={columnHeight}
            />
          ) : (
            <SingleColumnPicker<RightDisplaySlot<R>>
              label={rightProps.label ?? 'Options'}
              items={display}
              filter={nav.right.filter}
              selectedIndex={selectedDisplayIndex}
              isActive={nav.activeColumn === 'right'}
              height={columnHeight}
              visibleRows={maxVisible}
              getKey={(slot) => slot.key}
              lineCountOf={(slot) => (slot.kind === 'guidance' ? 2 : 1)}
              contentMaxWidth={rightContentWidth}
              onRowActivate={(displayIndex) => {
                const slot = display[displayIndex];
                if (slot?.kind !== 'row') return;
                // A row that steps its own value is a control, not a choice: a
                // click on it must not confirm the picker and dismiss it. A row that
                // only holds the space key is still a choice, so it stays clickable.
                if (nav.cycleRight(slot.navIndex) === 'stepped') return;
                nav.activateRight(slot.navIndex);
              }}
              rowZonePrefix="runner-right"
              rowZoneZ={ROW_ZONE_Z_OVERLAY}
              renderRow={(slot, isCursor, maxWidth) => {
                if (slot.kind === 'spacer') {
                  return <Text color={t.textDim}> </Text>;
                }
                if (slot.kind === 'header') {
                  return (
                    <Text color={t.textDim} wrap="truncate-end">
                      {`  ${glyph('divider')}${glyph('divider')} ${slot.section.toUpperCase()}`}
                    </Text>
                  );
                }
                if (slot.kind === 'guidance') return rightProps.placeholder ?? null;
                if (isVirtualCustomItem(slot.item)) {
                  return (
                    <ListRow
                      label="+ Add custom model…"
                      state={isCursor ? 'active' : 'default'}
                      defaultLead="dot"
                      width={maxWidth}
                    />
                  );
                }
                return rightProps.renderRow(slot.item, { isCursor, maxWidth });
              }}
            />
          )}
        </Box>
      </Box>
      <Box width={totalBoxWidth} marginTop={1}>
        <Text color={t.textDim} wrap="truncate-end">
          {showPreview ? previewText : ' '}
        </Text>
      </Box>
      <Box width={totalBoxWidth} marginTop={1}>
        <Text color={t.textDim} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
