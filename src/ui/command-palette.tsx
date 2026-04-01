import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CommandPaletteItem, Screen } from '../types.js';
import type { Theme } from '../theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { computeScrollOffset, truncate } from './picker-utils.js';

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
  const { cols, rows, isSmall } = useResponsiveLayout();

  const contentWidth = Math.min(cols - 4, isSmall ? 60 : 80);
  const nameColWidth = isSmall ? 14 : 18;
  const cursorWidth = 2;
  const shortcutMaxWidth = 10;
  const gapWidth = 2;
  const descMaxWidth = Math.max(10, contentWidth - cursorWidth - nameColWidth - gapWidth - shortcutMaxWidth);

  const screenItems = items.filter((item) => item.availableOn.includes(currentScreen));
  const filtered = !filter
    ? screenItems
    : screenItems.filter((item) => {
        const lower = filter.toLowerCase();
        return item.label.toLowerCase().includes(lower) || item.description.toLowerCase().includes(lower);
      });

  const maxVisible = Math.max(rows - 12, 5);
  const scrollOffset = computeScrollOffset(selectedIndex, maxVisible, filtered.length);
  const visibleSlice = filtered.slice(scrollOffset, scrollOffset + maxVisible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < filtered.length;

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
    <Box flexDirection="column" width={cols} height={rows} alignItems="center" paddingTop={1}>
      <Box flexDirection="column" width={contentWidth}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>Command Palette</Text>
        </Box>

        <Box borderStyle="round" borderColor={t.border} paddingX={1} marginBottom={1} width={contentWidth}>
          <Text color={t.accent}>&gt; </Text>
          <Text>{filter || <Text color={t.textDim}>Type to filter...</Text>}</Text>
        </Box>

        {showScrollUp && (
          <Text color={t.textDim}>{'  \u2191 more'}</Text>
        )}

        <Box flexDirection="column">
          {visibleSlice.map((item, i) => {
            const globalIndex = scrollOffset + i;
            const isCursor = globalIndex === selectedIndex;
            const name = truncate(item.label, nameColWidth).padEnd(nameColWidth);
            const desc = truncate(item.description, descMaxWidth);
            const shortcut = item.shortcut ? truncate(`[${item.shortcut}]`, shortcutMaxWidth) : '';

            return (
              <Box key={item.label}>
                <Text color={isCursor ? t.accent : t.text}>
                  {isCursor ? '\u25b8 ' : '  '}
                </Text>
                <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{name}</Text>
                <Text color={t.textDim}>{'  '}{desc}</Text>
                {shortcut && <Text color={t.textDim}> {shortcut}</Text>}
              </Box>
            );
          })}
          {filtered.length === 0 && (
            <Text color={t.textDim}>  No matching commands</Text>
          )}
        </Box>

        {showScrollDown && (
          <Text color={t.textDim}>{'  \u2193 more'}</Text>
        )}
      </Box>

      <Box flexGrow={1} />

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{'\u2191\u2193 navigate  Enter select  Esc close'}</Text>
      </Box>
    </Box>
  );
}
