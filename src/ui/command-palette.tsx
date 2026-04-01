import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CommandPaletteItem, Screen } from '../types.js';
import type { Theme } from '../theme.js';

interface CommandPaletteProps {
  items: CommandPaletteItem[];
  currentScreen: Screen;
  onExecute: (item: CommandPaletteItem) => void;
  onClose: () => void;
  theme: Theme;
}

export function CommandPalette({ items, currentScreen, onExecute, onClose, theme: t }: CommandPaletteProps) {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const screenItems = items.filter((item) => item.availableOn.includes(currentScreen));
  const filtered = !filter
    ? screenItems
    : screenItems.filter((item) => {
        const lower = filter.toLowerCase();
        return item.label.toLowerCase().includes(lower) || item.description.toLowerCase().includes(lower);
      });

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return && filtered.length > 0) {
      onExecute(filtered[selectedIndex]);
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilter((prev) => prev + input);
      setSelectedIndex(0);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={t.accent}>Command Palette</Text>
      </Box>

      <Box borderStyle="round" borderColor={t.border} paddingX={1} marginBottom={1}>
        <Text color={t.accent}>&gt; </Text>
        <Text>{filter || <Text color={t.textDim}>Type to filter...</Text>}</Text>
      </Box>

      <Box flexDirection="column">
        {filtered.map((item, i) => (
          <Box key={item.label}>
            <Text color={i === selectedIndex ? t.accent : t.text}>
              {i === selectedIndex ? '▸ ' : '  '}
            </Text>
            <Box width={20}>
              <Text color={i === selectedIndex ? t.accent : t.text} bold={i === selectedIndex}>
                {item.label}
              </Text>
            </Box>
            <Text color={t.textDim}>{item.description}</Text>
            {item.shortcut && (
              <Text color={t.textDim}>  [{item.shortcut}]</Text>
            )}
          </Box>
        ))}
        {filtered.length === 0 && (
          <Text color={t.textDim}>  No matching commands</Text>
        )}
      </Box>

      <Box justifyContent="center" marginTop={1}>
        <Text color={t.textDim}>↑↓ navigate  Enter select  Esc close</Text>
      </Box>
    </Box>
  );
}
