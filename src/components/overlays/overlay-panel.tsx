import { ThemeText as Text, useTheme } from '../theme.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { borderStyleFor } from '../../lib/glyphs.js';
import { fitKeyLegend } from '../../core/key-legend.js';
import { SOFT_SEP } from '../../core/separators.js';
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

/** The card a page asks a body to paint itself in, so the body can budget the card's rows. */
export interface OverlayCard {
  title: string;
  density: OverlayDensity;
}

interface OverlayPanelProps {
  title?: string | undefined;
  hint?: string | undefined;
  /** `tight` buys back the blank row under the title for panels that budget their own body rows. */
  titleSpacing?: 'gap' | 'tight' | undefined;
  /** `0` buys back the blank rows inside the border, for a body that budgets its own rows. */
  paddingY?: 0 | 1 | undefined;
  density: OverlayDensity;
  children: ReactNode;
}

export function OverlayPanel({
  title,
  hint,
  titleSpacing = 'gap',
  paddingY = 1,
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

  // A key legend sheds whole trailing keys; any other hint, such as an error or a status, truncates.
  const hintNode = hint && (
    <Box marginTop={1} width={rect.innerWidth}>
      <Text color={t.textDim} wrap="truncate-end">
        {hint.includes(SOFT_SEP) ? fitKeyLegend(hint, rect.innerWidth) : hint}
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
        paddingY={paddingY}
      >
        {titleNode}
        {children}
        {hintNode}
      </Box>
    </Box>
  );
}
