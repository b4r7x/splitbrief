import { Box, Text } from 'ink';
import { useTheme } from './theme.js';

export type FilterInputVariant = 'bordered' | 'inline' | 'prompt';

interface FilterInputProps {
  filter: string;
  placeholder?: string;
  variant?: FilterInputVariant;
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

  if (variant === 'prompt') {
    return (
      <Box height={1} overflow="hidden">
        <Text color={t.textDim}>{'❯ '}</Text>
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={filter ? t.text : t.textDim} wrap="truncate-end">
            {filter || placeholder}
          </Text>
        </Box>
        <Text color={t.accent}>_</Text>
        <Box flexGrow={1} />
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
