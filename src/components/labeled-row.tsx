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
    <Box>
      <Box width={labelWidth}>
        <Text color={t.textDim}>{label}</Text>
      </Box>
      {children}
    </Box>
  );
}
