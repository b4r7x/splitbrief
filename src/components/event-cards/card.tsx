import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from '../../ui/spinner.js';
import { useTheme } from '../../ui/theme.js';
import { formatDuration } from '../../utils/format.js';

interface CardProps {
  role?: string;
  roleColor?: string;
  label?: React.ReactNode;
  labelColor?: string;
  value?: React.ReactNode;
  valueColor?: string;
  trailing?: React.ReactNode;
  duration?: number;
  spinner?: {
    label: string;
    color: string;
    startTime: number;
  } | null;
  details?: React.ReactNode;
}

export function Card(props: CardProps): React.ReactElement {
  const { role, roleColor, label, labelColor, value, valueColor, trailing, duration, spinner, details } = props;
  const t = useTheme();

  return (
    <Box flexDirection="column">
      <Box>
        {role && <Text color={roleColor ?? t.textDim}>{role}  </Text>}
        {label && <Text color={labelColor ?? t.text}>{label}  </Text>}
        {value && <Text color={valueColor ?? t.text}>{value}</Text>}
        {trailing && <Box marginLeft={1}>{trailing}</Box>}
        {duration !== undefined && <Text color={t.textDim}>  {formatDuration(duration)}</Text>}
      </Box>
      {spinner && (
        <Box>
          <Spinner label={spinner.label} color={spinner.color} startTime={spinner.startTime} />
        </Box>
      )}
      {details && <Box marginLeft={2}>{details}</Box>}
    </Box>
  );
}
