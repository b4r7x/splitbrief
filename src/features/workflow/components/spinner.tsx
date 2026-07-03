import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { useSpinnerFrame } from '../hooks/use-spinner-frame.js';

type SpinnerProps = {
  label: ReactNode;
  color?: string;
};

export function Spinner({ label, color }: SpinnerProps) {
  const t = useTheme();
  const resolvedColor = color ?? t.spinner;
  const { frame } = useSpinnerFrame(true);

  return (
    <Box>
      <Text color={resolvedColor}>{frame}</Text>
      <Text color={resolvedColor}> {label}</Text>
    </Box>
  );
}
