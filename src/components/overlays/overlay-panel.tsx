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
  /** `tight` buys back the blank row under the title for panels that budget their own body rows. */
  titleSpacing?: 'gap' | 'tight' | undefined;
  density: OverlayDensity;
  children: ReactNode;
}

export function OverlayPanel({
  title,
  hint,
  titleSpacing = 'gap',
  density,
  children,
}: OverlayPanelProps) {
  const t = useTheme();
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const rect = overlayRect({ cols, rows, density });

  // Surface titles stay quiet dim metadata (§1.1 accent budget).
  const titleNode = title && (
    <Box marginBottom={titleSpacing === 'tight' ? 0 : 1}>
      <Text color={t.textDim}>{title}</Text>
    </Box>
  );

  // Hints truncate rather than wrap; callers write the key glyphs first so the surviving
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
