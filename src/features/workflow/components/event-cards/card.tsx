import type { ReactNode, ReactElement } from 'react';
import { Box, Text } from 'ink';

interface CardProps {
  label?: ReactNode;
  labelColor?: string;
  value?: ReactNode;
  valueColor?: string;
  header?: ReactNode;
  body?: ReactNode;
}

export function Card(props: CardProps): ReactElement {
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
