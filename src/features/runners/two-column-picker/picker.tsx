import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import { ListRow } from '../../../components/list-row/row.js';
import type { FilterableItem } from '../../../components/pickers/filtering.js';
import { availableRows } from '../../../components/pickers/scroll-offset.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { wrapOnWords } from '../picker/byline.js';
import { overlayWidth } from '../../../core/navigation/overlay-rect.js';
import { useStores } from '../../../stores/use-many.js';
import { SingleColumnPicker } from './single-column.js';
import { ROW_ZONE_Z_OVERLAY } from '../../../components/pickers/row-zone.js';
import { glyph } from '../../../lib/glyphs.js';
import type { LeftColumnProps, RightColumnProps } from './types.js';
import { useTwoColumnState } from './use-nav-state.js';
import { isRealRightItem, isVirtualCustomItem } from './virtual-items.js';
import { bylineLines, BYLINE_ROWS, getHint, type PickerHintKind } from './hint.js';
import { TerminalPaneCard } from './terminal-pane-card.js';
import { buildRightDisplay, type RightDisplaySlot } from './right-display.js';

export interface PreviewContext<L, R> {
  activeColumn: 'left' | 'right';
  leftItem: L | undefined;
  rightItem: R | null;
  isOnCustomItem: boolean;
  /** Cells the byline may spend: the panel width the preview line is rendered at. */
  bylineBudget: number;
}

export interface TwoColumnPickerProps<L extends FilterableItem, R extends { id: string }> {
  title: string;
  stepLabel?: string | undefined;
  initialColumn?: 'left' | 'right' | undefined;
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
  /** The byline under the columns. Each line of its text starts a row of its own. */
  preview?: ((ctx: PreviewContext<L, R>) => string | undefined) | undefined;
  /**
   * The notice standing right now, in its voice: a refusal, or a save the config refused. The
   * overlay hides the composer that would carry it, so it takes the byline at every width until
   * it clears.
   */
  notice?: Readonly<{ message: string | null; isError: boolean }> | undefined;
}

const PREVIEW_MIN_COLS = 50;
const INNER_PADDING = 4;
const COLUMN_GAP = 3;
const OUTER_CHROME_ROWS = 6;
const INNER_CHROME_ROWS = 4;
/** The least room between the title and a step label that shares its row. */
const HEAD_GAP = 2;
const VISIBLE_ROWS_CAP = 18;

export function TwoColumnPicker<L extends FilterableItem, R extends { id: string }>({
  title,
  stepLabel,
  initialColumn = 'left',
  leftProps,
  rightProps,
  onConfirm,
  onCancel,
  onRefresh,
  preview,
  notice,
}: TwoColumnPickerProps<L, R>) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);

  const totalBoxWidth = overlayWidth({ cols, density: 'wide' });
  // The columns reserve every wrapped label row so the header stays inside the viewport.
  const headStacked =
    stepLabel !== undefined &&
    stepLabel !== '' &&
    getTerminalCellWidth(title) + HEAD_GAP + getTerminalCellWidth(stepLabel) > totalBoxWidth;
  const stepLabelLines = headStacked
    ? wrapOnWords(stepLabel, totalBoxWidth, Number.POSITIVE_INFINITY).lines
    : stepLabel
      ? [stepLabel]
      : [];
  const maxVisible = Math.min(
    availableRows({
      rows,
      chromeRows: OUTER_CHROME_ROWS + INNER_CHROME_ROWS + (headStacked ? stepLabelLines.length : 0),
    }),
    VISIBLE_ROWS_CAP,
  );
  const columnHeight = maxVisible + INNER_CHROME_ROWS;
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
  const rightZoneTool =
    nav.left.currentItem === undefined ? '' : leftProps.getKey(nav.left.currentItem);
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
    width: totalBoxWidth,
    enterHint:
      nav.activeColumn === 'right'
        ? rightProps.enterHint?.(
            rightCurrent && isRealRightItem(rightCurrent) ? rightCurrent : undefined,
          )
        : undefined,
  });

  const rawPreview =
    terminalPane !== undefined
      ? undefined
      : preview?.({
          activeColumn: nav.activeColumn,
          leftItem: nav.left.currentItem,
          rightItem: rightCurrent && isRealRightItem(rightCurrent) ? rightCurrent : null,
          isOnCustomItem: nav.isOnCustomItem,
          bylineBudget: totalBoxWidth,
        });
  const previewText =
    rawPreview === undefined
      ? undefined
      : sanitizeTerminalDisplayText(rawPreview, { preserveLineBreaks: true });
  const showPreview = previewText !== undefined && previewText !== '' && cols > PREVIEW_MIN_COLS;
  const byline =
    notice === undefined || notice.message === null
      ? { lines: showPreview ? bylineLines(previewText, totalBoxWidth) : [' '], color: t.textDim }
      : {
          lines: bylineLines(sanitizeTerminalDisplayText(notice.message), totalBoxWidth),
          color: notice.isError ? t.error : t.textDim,
        };
  const leftEmptyText = `No ${(leftProps.label ?? 'items').toLowerCase()} match`;
  const wheelStep = (direction: 'up' | 'down'): 1 | -1 => (direction === 'up' ? -1 : 1);

  return (
    <Box
      width={cols}
      height={rows}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <Box
        width={totalBoxWidth}
        marginBottom={1}
        flexDirection={headStacked ? 'column' : 'row'}
        justifyContent="space-between"
      >
        <Box>
          <Text color={t.accent}>{title}</Text>
        </Box>
        {stepLabelLines.map((line, rowIndex) => (
          <Text key={rowIndex} color={t.textDim}>
            {line}
          </Text>
        ))}
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
            onRowActivate={nav.clickLeft}
            onWheel={(direction) => nav.wheelLeft(wheelStep(direction))}
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
                if (slot?.kind === 'row') nav.clickRight(slot.navIndex);
              }}
              onWheel={(direction) => nav.wheelRight(wheelStep(direction))}
              // A click acts on the row that was drawn, and a row is drawn for one tool.
              rowZonePrefix={`runner-right:${rightZoneTool}`}
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
                      width={maxWidth}
                      keepWhole="label"
                    />
                  );
                }
                return rightProps.renderRow(slot.item, { isCursor, maxWidth });
              }}
            />
          )}
        </Box>
      </Box>
      <Box
        width={totalBoxWidth}
        height={BYLINE_ROWS}
        overflow="hidden"
        marginTop={1}
        flexDirection="column"
      >
        {byline.lines.map((line, rowIndex) => (
          <Text key={rowIndex} color={byline.color} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
      <Box width={totalBoxWidth}>
        <Text color={t.textDim} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
