import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';

export type FilterInputVariant = 'plain' | 'inline' | 'prompt';

interface FilterInputProps {
  filter: string;
  placeholder?: string;
  variant?: FilterInputVariant;
}

export function FilterInput({
  filter,
  placeholder = 'type to filter…',
  variant = 'plain',
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
        <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          {filter ? (
            <Text color={t.text} wrap="truncate-end">
              {filter}
            </Text>
          ) : null}
          <Text color={t.textDim}>{glyph('editCursor')}</Text>
          {filter ? null : (
            <Text color={t.textDim} wrap="truncate-end">
              {placeholder}
            </Text>
          )}
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  return (
    <Box height={1} overflow="hidden" marginBottom={1}>
      <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
      <Box flexShrink={1} minWidth={0} overflow="hidden">
        <Text wrap="truncate-end">{value}</Text>
      </Box>
    </Box>
  );
}
