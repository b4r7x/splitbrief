import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth, getResponsivePanelWidth } from '../../utils/terminal-width.js';
import { useStores } from '../../stores/use-stores.js';

interface OverlayPanelProps {
  title?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
  width?: number | 'auto' | undefined;
  maxWidth?: number | undefined;
  bordered?: boolean | undefined;
  paddingX?: number | undefined;
  paddingY?: number | undefined;
}

export function OverlayPanel({
  title,
  hint,
  children,
  width: widthProp,
  maxWidth,
  bordered = true,
  paddingX = 2,
  paddingY = 1,
}: OverlayPanelProps) {
  const t = useTheme();
  const [{ cols, rows, isSmall }] = useStores(terminalSizeStore);

  const resolvedMaxWidth = maxWidth ?? getResponsivePanelWidth(cols, isSmall);
  const resolvedWidth =
    widthProp === 'auto' ? undefined : getClampedTerminalWidth(cols, widthProp ?? resolvedMaxWidth);

  const titleNode = title && (
    <Box justifyContent="center" marginBottom={1}>
      <Text bold color={t.accent}>
        {title}
      </Text>
    </Box>
  );

  const hintNode = hint && (
    <Box justifyContent="center" marginTop={1}>
      <Text color={t.textDim}>{hint}</Text>
    </Box>
  );

  const inner = (
    <Box flexDirection="column" width={resolvedWidth}>
      {bordered ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={t.border}
          paddingX={paddingX}
          paddingY={paddingY}
        >
          {titleNode}
          {children}
          {hintNode}
        </Box>
      ) : (
        <Box flexDirection="column">
          {titleNode}
          {children}
          {hintNode}
        </Box>
      )}
    </Box>
  );

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      {inner}
    </Box>
  );
}
