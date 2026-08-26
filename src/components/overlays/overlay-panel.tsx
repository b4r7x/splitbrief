import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { borderStyleFor } from '../../lib/glyphs.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import {
  OVERLAY_FRAME_ROWS,
  type OverlayDensity,
  overlayGutterRows,
  overlayRect,
} from '../../core/navigation/overlay-rect.js';
import { useStores } from '../../stores/use-stores.js';

export function overlayInnerRowCapacity(input: { rows: number; outerChromeRows: number }): number {
  return Math.max(
    0,
    input.rows - overlayGutterRows(input.rows) - OVERLAY_FRAME_ROWS - input.outerChromeRows,
  );
}

interface OverlayPanelProps {
  title?: string | undefined;
  hint?: string | undefined;
  density: OverlayDensity;
  children: ReactNode;
}

export function OverlayPanel({ title, hint, density, children }: OverlayPanelProps) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const rect = overlayRect({ cols, rows, density });

  // Surface titles stay quiet dim metadata (§1.1 accent budget) and use sentence case — first word
  // capitalized — like every TUI title, label, status, and empty state. Three token classes stay lowercase
  // even at string start: key tokens (esc, ctrl+k, ⏎, space), slash commands (/settings), and config enum
  // values (standard, auto, cli). Real role titles (the runner picker) still hand-roll their own accent.
  const titleNode = title && (
    <Box marginBottom={1}>
      <Text color={t.textDim}>{title}</Text>
    </Box>
  );

  // Hints truncate rather than wrap (REQ-005); callers write the key glyphs first so the surviving
  // prefix stays actionable.
  const hintNode = hint && (
    <Box marginTop={1} width={rect.innerWidth}>
      <Text color={t.textDim} wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={rect.width}
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
