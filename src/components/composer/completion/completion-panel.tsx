import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import { type ScrollbarThumb, scrollbarCell } from '../../scrollbar.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { clamp } from '../../../utils/math.js';
import { windowSlice } from '../../pickers/scroll-window.js';

export function CompletionPanel<T>({
  items,
  selectedIndex,
  maxVisible,
  footer,
  isOpen,
  itemKey,
  renderRow,
  renderEmpty,
}: {
  items: T[];
  selectedIndex: number;
  maxVisible: number;
  footer: string;
  isOpen?: boolean | undefined;
  itemKey: (item: T) => string;
  renderRow: (opts: {
    item: T;
    globalIndex: number;
    isSelected: boolean;
    rowBg: string;
    panelBg: string;
    visibleItems: T[];
  }) => ReactNode;
  renderEmpty?: ((panelBg: string) => ReactNode) | undefined;
}) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  if (!(isOpen ?? items.length > 0)) return null;

  const panelBg = t.suggestionPanelBg;
  const { scrollOffset, visibleSlice, showScrollUp, showScrollDown } = windowSlice({
    items,
    selectedIndex,
    windowSize: maxVisible,
  });
  const overflow = showScrollUp || showScrollDown;
  const aboveCount = scrollOffset;
  const belowCount = items.length - (scrollOffset + visibleSlice.length);
  const upLabel = showScrollUp ? `↑${aboveCount}` : '';
  const downLabel = showScrollDown ? `↓${belowCount}` : '';
  // A single constant-width gutter for every visible row: the count column is reserved (and blank on
  // the middle rows) so the description never reflows row-to-row, and a fixed 1-cell pad keeps the
  // bar off the text. Arrow glyphs and digits are all one cell wide, so string length is cell width.
  const countWidth = Math.max(upLabel.length, downLabel.length);
  const thumb = menuScrollThumb({
    selectedIndex,
    lineCount: items.length,
    visibleHeight: visibleSlice.length,
  });
  const emptyRow = renderEmpty?.(panelBg);

  const rows: ReactNode[] = [];
  for (const [i, item] of visibleSlice.entries()) {
    const globalIndex = scrollOffset + i;
    const isSelected = globalIndex === selectedIndex;
    const rowBg = isSelected ? t.selectionBg : panelBg;
    const onThumb = scrollbarCell(i, thumb);
    const isFirst = i === 0;
    const isLast = i === visibleSlice.length - 1;
    const countLabel =
      isFirst && showScrollUp ? upLabel : isLast && showScrollDown ? downLabel : '';
    rows.push(
      <Box key={itemKey(item)} width="100%" height={1} overflow="hidden" backgroundColor={rowBg}>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          {renderRow({ item, globalIndex, isSelected, rowBg, panelBg, visibleItems: visibleSlice })}
        </Box>
        {overflow ? (
          <Box flexShrink={0} backgroundColor={rowBg}>
            <Text color={t.scrollIndicator}>{`${countLabel.padStart(countWidth)} `}</Text>
            <Text color={onThumb ? t.accent : t.scrollIndicator}>
              {onThumb ? glyph('scrollThumb') : glyph('scrollTrack')}
            </Text>
          </Box>
        ) : null}
      </Box>,
    );
  }
  if (emptyRow) {
    rows.push(
      <Box key="empty" width="100%" height={1} overflow="hidden" backgroundColor={panelBg}>
        {emptyRow}
      </Box>,
    );
  }
  rows.push(
    <Box key="divider" width="100%" height={1} overflow="hidden" backgroundColor={panelBg}>
      <Text color={t.border}>{glyph('divider').repeat(Math.max(0, cols - 2))}</Text>
    </Box>,
  );
  rows.push(
    <Box key="footer" width="100%" height={1} overflow="hidden" backgroundColor={panelBg}>
      <Text color={t.textDim} wrap="truncate-end">
        {footer}
      </Text>
    </Box>,
  );

  return (
    <Box flexDirection="column" width="100%">
      <OcclusionBackplate rows={rows.length + 2} width={Math.max(0, cols)} />
      <Box
        flexDirection="column"
        width="100%"
        borderStyle={borderStyleFor('round')}
        borderColor={t.border}
        backgroundColor={panelBg}
      >
        {rows}
      </Box>
    </Box>
  );
}

// Opaque space-fill behind the entire bordered footprint (outer width times all rows plus the two border
// lines). Background color alone is dropped under NO_COLOR/FORCE_COLOR=0, which would let the
// transcript bleed through the popup; literal spaces occlude on every host. Painted first so the
// bordered card renders on top.
function OcclusionBackplate({ rows, width }: { rows: number; width: number }) {
  const line = ' '.repeat(width);
  const block = Array.from({ length: rows }, () => line).join('\n');
  return (
    <Box position="absolute" width={width} height={rows}>
      <Text>{block}</Text>
    </Box>
  );
}

// The thumb tracks the selected item's position in the full list (1:1) instead of the window offset,
// so it glides on every arrow press rather than freezing while the selection moves inside the window
// and then jumping when the window finally slides. Same proportional thumb size as the shared bar.
function menuScrollThumb(input: {
  selectedIndex: number;
  lineCount: number;
  visibleHeight: number;
}): ScrollbarThumb {
  const { selectedIndex, lineCount, visibleHeight } = input;
  if (lineCount <= visibleHeight || visibleHeight <= 0) {
    return { thumbStart: 0, thumbSize: Math.max(0, visibleHeight) };
  }
  const thumbSize = Math.max(1, Math.round((visibleHeight * visibleHeight) / lineCount));
  const maxThumbStart = visibleHeight - thumbSize;
  const clampedIndex = clamp(selectedIndex, 0, lineCount - 1);
  return {
    thumbStart: Math.round((clampedIndex * maxThumbStart) / (lineCount - 1)),
    thumbSize,
  };
}
