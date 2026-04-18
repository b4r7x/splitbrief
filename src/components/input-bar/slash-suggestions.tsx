import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import type { SlashCommandDef } from '../../core/slash-commands/types.js';

interface SlashSuggestionsProps {
  filtered: SlashCommandDef[];
  selectedIndex: number;
  fuzzyMatch?: SlashCommandDef | null;
}

export function SlashSuggestions({ filtered, selectedIndex, fuzzyMatch }: SlashSuggestionsProps) {
  const t = useTheme();
  if (filtered.length === 0 && !fuzzyMatch) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      backgroundColor={t.panelBg || undefined}
      paddingX={1}
      width="100%"
    >
      {filtered.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box
            key={cmd.name}
            backgroundColor={isSelected ? t.selectionBg : undefined}
            paddingX={1}
          >
            <Text color={isSelected ? t.accent : t.textDim}>
              {isSelected ? '▸' : ' '}
            </Text>
            <Text> </Text>
            <Box width={14}>
              <Text color={isSelected ? t.accent : t.text} bold={isSelected}>
                {cmd.name}
              </Text>
            </Box>
            <Text color={isSelected ? t.text : t.textDim}>{cmd.description}</Text>
            {cmd.shortcut && (
              <Text color={t.textDim}> [{cmd.shortcut}]</Text>
            )}
          </Box>
        );
      })}
      {fuzzyMatch && filtered.length === 0 && (
        <Box paddingX={1}>
          <Text color={t.textDim}>{'▸'}</Text>
          <Text> </Text>
          <Box width={14}>
            <Text color={t.textDim}>{fuzzyMatch.name}</Text>
          </Box>
          <Text color={t.textDim}>{fuzzyMatch.description}</Text>
          <Text color={t.textDim}> (fuzzy)</Text>
        </Box>
      )}
      <Box justifyContent="center" paddingTop={1}>
        <Text color={t.textDim}>↑↓ select  Enter run  Tab fill  Esc close</Text>
      </Box>
    </Box>
  );
}
