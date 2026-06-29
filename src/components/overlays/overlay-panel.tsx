import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { borderStyleFor } from '../../lib/glyphs.js';
import { availableRows } from '../pickers/scroll-window.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth, getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { useStores } from '../../stores/use-stores.js';

export const OVERLAY_PANEL_BORDER_ROWS = 2;
export const OVERLAY_PANEL_PADDING_Y_ROWS = 2;
export const OVERLAY_PANEL_FRAME_ROWS = OVERLAY_PANEL_BORDER_ROWS + OVERLAY_PANEL_PADDING_Y_ROWS;
export const OVERLAY_PANEL_BORDER_COLS = 2;
export const OVERLAY_PANEL_PADDING_X_COLS = 4;
export const OVERLAY_PANEL_FRAME_COLS = OVERLAY_PANEL_BORDER_COLS + OVERLAY_PANEL_PADDING_X_COLS;

export function computeOverlayInnerRowCapacity(opts: {
  terminalRows: number;
  outerChromeRows?: number | undefined;
}): number {
  return availableRows({
    rows: opts.terminalRows,
    chromeRows: (opts.outerChromeRows ?? 0) + OVERLAY_PANEL_FRAME_ROWS,
    floor: 0,
  });
}

export function computeOverlayInnerWidth(outerWidth: number): number {
  return Math.max(1, outerWidth - OVERLAY_PANEL_FRAME_COLS);
}

interface OverlayPanelProps {
  title?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
  width?: number | 'auto' | undefined;
  maxWidth?: number | undefined;
}

export function OverlayPanel({
  title,
  hint,
  children,
  width: widthProp,
  maxWidth,
}: OverlayPanelProps) {
  const t = useTheme();
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);

  const resolvedMaxWidth =
    maxWidth ?? getResponsivePanelWidth({ cols, size: isSmall ? 'small' : 'large' });
  const resolvedWidth =
    widthProp === 'auto'
      ? undefined
      : getClampedTerminalWidth({ cols, maxWidth: widthProp ?? resolvedMaxWidth });

  // Surface titles are quiet dim metadata (§1.1 accent budget): the single accent cell per region is
  // the focused row bar, never the title head. Real role titles (the runner picker) hand-roll their
  // own accent rather than routing through OverlayPanel.
  const titleNode = title && (
    <Box marginBottom={1}>
      <Text color={t.textDim}>{title}</Text>
    </Box>
  );

  const hintNode = hint && (
    <Box marginTop={1}>
      <Text color={t.textDim}>{hint}</Text>
    </Box>
  );

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={resolvedWidth}
        borderStyle={borderStyleFor('round')}
        borderColor={t.border}
        paddingX={2}
        paddingY={1}
      >
        {titleNode}
        {children}
        {hintNode}
      </Box>
    </Box>
  );
}
