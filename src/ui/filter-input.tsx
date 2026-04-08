import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

interface FilterInputProps {
  filter: string;
  placeholder?: string;
}

export function FilterInput({ filter, placeholder = 'Type to filter...' }: FilterInputProps) {
  const t = useTheme();
  return (
    <Box borderStyle="round" borderColor={t.border} paddingX={1} marginBottom={1}>
      <Text color={t.accent}>{'> '}</Text>
      <Text>{filter || <Text color={t.textDim}>{placeholder}</Text>}</Text>
    </Box>
  );
}
