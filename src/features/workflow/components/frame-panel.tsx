import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../../../components/theme.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextStart,
} from '../../../utils/display-text.js';
import { Divider } from '../../../components/divider.js';

interface FramePanelProps {
  filePath: string;
  /** Dim text the title row ends with; the path gives up its leading cells to it. */
  aside?: string | undefined;
  width: number;
  height: number;
  children: ReactNode;
}

export const OVERLAY_FRAME_COLS = 4; // border(2) + paddingX(2)

export function FramePanel({ filePath, aside, width, height, children }: FramePanelProps) {
  const t = useTheme();
  const innerWidth = Math.max(1, width - OVERLAY_FRAME_COLS);
  const asideCells = aside === undefined ? 0 : getTerminalCellWidth(aside) + 2;
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={borderStyleFor('single')}
      borderColor={t.border}
      borderDimColor
      paddingX={1}
      overflow="hidden"
    >
      <Box height={1} overflow="hidden">
        {renderFrameTitle(filePath, innerWidth - asideCells, t.textDim, t.text)}
        {aside !== undefined && (
          <>
            <Box flexGrow={1} />
            <Text color={t.textDim}>{aside}</Text>
          </>
        )}
      </Box>
      <Divider width={innerWidth} />
      {children}
    </Box>
  );
}

function renderFrameTitle(filePath: string, width: number, dim: string, fg: string) {
  const pip = '◇ ';
  const pathBudget = Math.max(1, width - getTerminalCellWidth(pip));
  const path = truncateTerminalDisplayTextStart(filePath, pathBudget);
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <Text>
      <Text color={dim}>{pip}</Text>
      {dir !== '' && <Text color={dim}>{dir}</Text>}
      <Text color={fg} bold>
        {base}
      </Text>
    </Text>
  );
}
