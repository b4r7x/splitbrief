import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { stripTerminalControls } from '../utils/display-text.js';
import { useTheme } from './theme.js';

export interface LabeledRowProps {
  label: string;
  labelWidth?: number;
  /** A seat row colours its label, never its value: the crew rows elsewhere read the same way. */
  labelColor?: string | undefined;
  children: ReactNode;
}

export function LabeledRow({ label, labelWidth = 14, labelColor, children }: LabeledRowProps) {
  const t = useTheme();
  return (
    <Box gap={1} overflow="hidden" flexShrink={0}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={labelColor ?? t.textDim} bold={labelColor !== undefined} wrap="truncate-end">
          {stripTerminalControls(label)}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
