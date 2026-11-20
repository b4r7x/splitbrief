import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box } from 'ink';
import type { FilterableItem } from '../../../components/pickers/filtering.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { useStores } from '../../../stores/use-many.js';
import { ListEntry, planListEntries } from '../../../components/list-row/rows.js';
import { getScrollViewportContentWidth } from '../../../components/scrollbar.js';
import { SingleColumnPicker } from './single-column.js';
import { ROW_ZONE_Z_OVERLAY } from '../../../components/pickers/row-zone.js';
import type { LeftColumnProps, RightColumnProps } from './types.js';
import { useTwoColumnState } from './use-nav-state.js';
import { isRealRightItem } from './virtual-items.js';
import { layoutNotice, Notice } from '../../../components/notice.js';
import type { FeedbackSeverity } from '../../../stores/ui/feedback.js';
import { bylineLines, BYLINE_ROWS, getHint, type PickerHintKind } from './hint.js';
import { PaneDetails } from './terminal-pane-card.js';
import { wrapPaneLines, fitPaneLines } from './pane-lines.js';
import { Divider } from '../../../components/divider.js';
import { pickerLayout, COLUMN_GAP, INNER_CHROME_ROWS } from './layout.js';
import { ModelsColumn } from './models-column.js';

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
  notice?: Readonly<{ message: string | null; severity: FeedbackSeverity }> | undefined;
}

const PREVIEW_MIN_COLS = 50;
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

  const {
    singlePane,
    totalBoxWidth,
    headStacked,
    stepLabelLines,
    maxVisible,
    columnHeight,
    leftBoxWidth,
    rightBoxWidth,
    leftContentWidth,
    rightContentWidth,
  } = pickerLayout({ cols, rows, title, stepLabel, minRowWidth: leftProps.minRowWidth });

  const nav = useTwoColumnState<L, R>({
    leftProps,
    rightProps,
    initialColumn,
    onConfirm,
    onCancel,
    onRefresh,
    singlePane,
    maxVisible,
  });

  const terminalPane = nav.terminalPane;
  const showTools = !singlePane || nav.activeColumn === 'left';
  const showModels = !singlePane || nav.activeColumn === 'right';
  const inlinePane = singlePane && showTools ? terminalPane : undefined;
  const inlineGuidance =
    singlePane &&
    showTools &&
    !inlinePane &&
    !nav.hasSelectableRight &&
    nav.left.currentItem !== undefined
      ? rightProps.placeholder
      : undefined;
  const hasInlineInfo = inlinePane !== undefined || inlineGuidance != null;
  const reclaimByline = hasInlineInfo && !notice?.message && (inlinePane !== undefined || !preview);
  const spare = reclaimByline ? BYLINE_ROWS + 1 : 0;
  // The tool cursor keeps one visible row. The details use the rest, including the space the
  // header and byline yield when the shortest terminal has a remedy to show.
  const toolSlots = maxVisible + (hasInlineInfo ? 1 + spare : 0);
  const paneLines = inlinePane ? wrapPaneLines(inlinePane, leftContentWidth) : [];
  const infoRows = hasInlineInfo
    ? Math.min(Math.max(0, toolSlots - 1), inlinePane ? paneLines.length + 3 : 3)
    : 0;
  const leftVisible = toolSlots - infoRows;
  const details = infoRows >= 2 && (
    <>
      <Divider width={leftContentWidth} />
      {inlinePane ? (
        <PaneDetails label={inlinePane.label} lines={fitPaneLines(paneLines, infoRows - 2)} />
      ) : (
        inlineGuidance
      )}
    </>
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
    columnHint: !singlePane ? '←→ column' : nav.activeColumn === 'right' ? '← tools' : '',
    enterHint:
      singlePane && nav.activeColumn === 'left'
        ? nav.hasSelectableRight
          ? '⏎ models'
          : ''
        : nav.activeColumn === 'right'
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
  // The byline has no room for a frame, so a notice takes it in its bar form.
  const noticeLayout =
    notice === undefined || notice.message === null
      ? null
      : layoutNotice(sanitizeTerminalDisplayText(notice.message), notice.severity, {
          maxWidth: totalBoxWidth,
          maxRows: BYLINE_ROWS,
        });
  const previewLines = showPreview ? bylineLines(previewText, totalBoxWidth) : [' '];
  const leftEmptyText = `No ${(leftProps.label ?? 'items').toLowerCase()} match`;
  const wheelStep = (direction: 'up' | 'down'): 1 | -1 => (direction === 'up' ? -1 : 1);

  const leftRowWidth = getScrollViewportContentWidth(leftContentWidth);
  const leftModels = nav.left.items.map((item, index) => {
    const isCursor = nav.activeColumn === 'left' && nav.left.index === index;
    const key = leftProps.getKey(item);
    const isSelected = nav.selectedLeftKey
      ? nav.selectedLeftKey === key
      : !!('isCurrent' in item && item.isCurrent);
    const isContext =
      nav.activeColumn === 'right' &&
      nav.left.currentItem !== undefined &&
      leftProps.getKey(item) === leftProps.getKey(nav.left.currentItem);
    return leftProps.rowModel(item, { isCursor, isSelected, isContext, maxWidth: leftRowWidth });
  });
  const leftLines = planListEntries(leftModels, leftRowWidth);

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
        marginBottom={hasInlineInfo ? 0 : 1}
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
        {showTools && (
          <Box width={leftBoxWidth} flexShrink={0}>
            <SingleColumnPicker<L>
              label={leftProps.label ?? 'Items'}
              items={nav.left.items}
              filter={nav.left.filter}
              selectedIndex={nav.left.index}
              isActive={nav.activeColumn === 'left'}
              height={toolSlots + INNER_CHROME_ROWS}
              details={details}
              visibleRows={leftVisible}
              getKey={leftProps.getKey}
              contentMaxWidth={leftContentWidth}
              emptyText={leftEmptyText}
              onRowActivate={nav.clickLeft}
              onWheel={(direction) => nav.wheelLeft(wheelStep(direction))}
              rowZonePrefix="runner-left"
              rowZoneZ={ROW_ZONE_Z_OVERLAY}
              renderRow={(_item, isCursor, width, index) => (
                <ListEntry
                  lines={leftLines.get(index) ?? []}
                  selected={isCursor}
                  state={leftModels[index]?.state}
                  width={width}
                />
              )}
            />
          </Box>
        )}
        {showModels && (
          <Box width={rightBoxWidth} flexShrink={0}>
            <ModelsColumn
              nav={nav}
              rightProps={rightProps}
              singlePane={singlePane}
              toolKey={
                nav.left.currentItem === undefined ? '' : leftProps.getKey(nav.left.currentItem)
              }
              rightContentWidth={rightContentWidth}
              columnHeight={columnHeight}
              maxVisible={maxVisible}
            />
          </Box>
        )}
      </Box>
      {!reclaimByline && (
        <Box
          width={totalBoxWidth}
          height={BYLINE_ROWS}
          overflow="hidden"
          marginTop={1}
          flexDirection="column"
        >
          {noticeLayout !== null ? (
            <Notice layout={noticeLayout} />
          ) : (
            previewLines.map((line, rowIndex) => (
              <Text key={rowIndex} color={t.textDim} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Box>
      )}
      <Box width={totalBoxWidth}>
        <Text color={t.textDim} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
