import { useRef, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import { getScrollbarThumb, scrollbarCell } from '../../scrollbar.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { keepInViewOffset } from '../../pickers/scroll-window.js';

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
  }) => ReactNode;
  renderEmpty?: ((panelBg: string) => ReactNode) | undefined;
}) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const offsetRef = useRef(0);
  if (!(isOpen ?? items.length > 0)) return null;

  const panelBg = t.suggestionPanelBg;
  const scrollOffset = keepInViewOffset({
    previous: offsetRef.current,
    index: selectedIndex,
    windowSize: maxVisible,
    totalItems: items.length,
  });
  offsetRef.current = scrollOffset;
  const visibleSlice = items.slice(scrollOffset, scrollOffset + maxVisible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + visibleSlice.length < items.length;
  const overflow = showScrollUp || showScrollDown;
  const aboveCount = scrollOffset;
  const belowCount = items.length - (scrollOffset + visibleSlice.length);
  const upLabel = showScrollUp ? `↑${aboveCount}` : '';
  const downLabel = showScrollDown ? `↓${belowCount}` : '';
  // A single constant-width gutter for every visible row: the count column is sized from the whole
  // list (not the labels the current window happens to show) so neither the description nor the bar
  // moves as the window scrolls, and it is padded on both sides so the counter never touches the
  // description or the bar. Arrows and digits are one cell wide, so string length is cell width.
  const countWidth = String(items.length).length + 1;
  const thumb = getScrollbarThumb({
    offset: scrollOffset,
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
          {renderRow({ item, globalIndex, isSelected, rowBg, panelBg })}
        </Box>
        {overflow ? (
          <Box flexShrink={0} backgroundColor={rowBg}>
            <Text color={t.scrollIndicator}>{` ${countLabel.padStart(countWidth)} `}</Text>
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
      <Text color={t.border}>{glyph('divider').repeat(Math.max(0, cols - 4))}</Text>
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
        paddingX={1}
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
// bordered card renders on top. It starts one cell left of the card, as it already runs past the
// right border, so a rule the card covers stops short of both borders instead of butting into one.
function OcclusionBackplate({ rows, width }: { rows: number; width: number }) {
  const line = ' '.repeat(width + 1);
  const block = Array.from({ length: rows }, () => line).join('\n');
  return (
    <Box position="absolute" marginLeft={-1} width={width + 1} height={rows}>
      <Text>{block}</Text>
    </Box>
  );
}
