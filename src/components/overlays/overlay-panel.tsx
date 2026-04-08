import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { useResponsiveLayout } from '../../hooks/use-terminal-size.js';

export interface OverlayPanelProps {
  title?: string;
  hint?: string;
  children: ReactNode;
  width?: number | 'auto';
  maxWidth?: number;
  bordered?: boolean;
  paddingX?: number;
  paddingY?: number;
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
  const { cols, rows, isSmall } = useResponsiveLayout();

  const resolvedMaxWidth = maxWidth ?? (isSmall ? 76 : 110);
  const resolvedWidth = widthProp === 'auto'
    ? undefined
    : (widthProp ?? Math.min(cols - 4, resolvedMaxWidth));

  const titleNode = title && (
    <Box justifyContent="center" marginBottom={1}>
      <Text bold color={t.accent}>{title}</Text>
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
    <Box
      width={cols}
      height={rows}
      alignItems="center"
      justifyContent="center"
    >
      {inner}
    </Box>
  );
}
