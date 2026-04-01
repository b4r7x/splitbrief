import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommandDef, Screen } from '../types.js';
import type { Theme } from '../theme.js';

interface SlashSuggestionsProps {
  filtered: SlashCommandDef[];
  selectedIndex: number;
  theme: Theme;
}

export function filterCommands(commands: SlashCommandDef[], filter: string, screen: Screen): SlashCommandDef[] {
  const screenCmds = commands.filter((cmd) => cmd.validScreens.includes(screen));
  if (!filter || filter === '/') return screenCmds;
  const lower = filter.toLowerCase();
  return screenCmds.filter((cmd) => cmd.name.toLowerCase().startsWith(lower));
}

export function SlashSuggestions({ filtered, selectedIndex, theme: t }: SlashSuggestionsProps) {
  if (filtered.length === 0) return null;

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
      <Box justifyContent="center" paddingTop={1}>
        <Text color={t.textDim}>↑↓ select  Enter run  Tab fill  Esc close</Text>
      </Box>
    </Box>
  );
}
