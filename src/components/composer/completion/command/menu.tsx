import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import { CompletionPanel } from '../completion-panel.js';

interface CommandCompletionMenuProps {
  filtered: RuntimeCommandDef[];
  selectedIndex: number;
  fuzzyMatch?: RuntimeCommandDef | null;
  maxVisible: number;
}

export function CommandCompletionMenu({ filtered, selectedIndex, fuzzyMatch, maxVisible }: CommandCompletionMenuProps) {
  const t = useTheme();
  return (
    <CompletionPanel
      items={filtered}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer="↑↓ select  Tab fill  Enter run  Esc close"
      isOpen={filtered.length > 0 || fuzzyMatch !== null}
      itemKey={cmd => cmd.name}
      renderRow={({ item: cmd, isSelected, rowBg }) => (
        <>
          <Text color={isSelected ? t.accent : t.textDim}>
            {isSelected ? '▸' : ' '}
          </Text>
          <Text> </Text>
          <Box width={14} backgroundColor={rowBg}>
            <Text color={isSelected ? t.accent : t.text} bold={isSelected} wrap="truncate-end">
              {cmd.name}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} backgroundColor={rowBg}>
            <Text color={isSelected ? t.text : t.textDim} wrap="truncate-end">
              {cmd.description}{cmd.shortcut ? ` [${cmd.shortcut}]` : ''}
            </Text>
          </Box>
        </>
      )}
      renderEmpty={(panelBg) => {
        if (!fuzzyMatch || filtered.length > 0) return null;
        return (
          <Box width="100%" backgroundColor={panelBg} paddingX={1}>
            <Text color={t.textDim}>{'▸'}</Text>
            <Text> </Text>
            <Box width={14} backgroundColor={panelBg}>
              <Text color={t.textDim} wrap="truncate-end">{fuzzyMatch.name}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} backgroundColor={panelBg}>
              <Text color={t.textDim} wrap="truncate-end">{fuzzyMatch.description} (fuzzy)</Text>
            </Box>
          </Box>
        );
      }}
    />
  );
}
