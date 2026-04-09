import React from 'react';
import { Box, Text } from 'ink';

interface CardProps {
  label?: React.ReactNode;
  labelColor?: string;
  value?: React.ReactNode;
  valueColor?: string;
  header?: React.ReactNode;
  body?: React.ReactNode;
}

export function Card(props: CardProps): React.ReactElement {
  const { label, labelColor, value, valueColor, header, body } = props;

  const hasRow = label || value;

  return (
    <Box flexDirection="column">
      {header}
      {hasRow && (
        <Box>
          {label && <Text {...(labelColor ? { color: labelColor } : {})}>{label}  </Text>}
          {value && <Text {...(valueColor ? { color: valueColor } : {})}>{value}</Text>}
        </Box>
      )}
      {body}
    </Box>
  );
}
