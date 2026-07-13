import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';

interface FilterInputProps {
  filter: string;
  placeholder?: string;
}

export function FilterInput({ filter, placeholder = 'Type to filter…' }: FilterInputProps) {
  const t = useTheme();
  return (
    <Box height={1} overflow="hidden">
      <Text color={t.accent}>{`${glyph('prompt')} `}</Text>
      <Box flexShrink={1} minWidth={0} overflow="hidden">
        {filter ? (
          <Text color={t.text} wrap="truncate-end">
            {filter}
          </Text>
        ) : (
          <Text color={t.textDim} wrap="truncate-end">
            {placeholder}
          </Text>
        )}
      </Box>
      <Box flexGrow={1} />
    </Box>
  );
}
