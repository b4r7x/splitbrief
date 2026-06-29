import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

export interface LabeledRowProps {
  label: string;
  labelWidth?: number;
  children: ReactNode;
}

export function LabeledRow({ label, labelWidth = 14, children }: LabeledRowProps) {
  const t = useTheme();
  return (
    <Box gap={1} overflow="hidden" flexShrink={0}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={t.textDim} wrap="truncate-end">
          {label}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
