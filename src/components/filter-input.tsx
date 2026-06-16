import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

interface FilterInputProps {
  filter: string;
  placeholder?: string;
  variant?: 'bordered' | 'inline';
}

export function FilterInput({
  filter,
  placeholder = 'Type to filter...',
  variant = 'bordered',
}: FilterInputProps) {
  const t = useTheme();
  const value = filter || <Text color={t.textDim}>{placeholder}</Text>;

  if (variant === 'inline') {
    return (
      <Box height={1} overflow="hidden">
        <Text color={t.accent}>{'filter '}</Text>
        <Text wrap="truncate-end">{value}</Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={t.border}
      paddingX={1}
      marginBottom={1}
      height={3}
      overflow="hidden"
    >
      <Text color={t.accent}>{'> '}</Text>
      <Text wrap="truncate-end">{value}</Text>
    </Box>
  );
}
