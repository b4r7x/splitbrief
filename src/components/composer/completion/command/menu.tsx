import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import {
  AlignedOptionRow,
  getAlignedOptionLabelWidth,
} from '../../../pickers/aligned-option-row.js';
import { CursorCell } from '../../../pickers/cursor-cell.js';
import { NO_CURSOR } from '../../../pickers/cursor-glyph.js';
import { SOFT_SEP } from '../../../separators.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CompletionPanel } from '../completion-panel.js';

const MAX_COMMAND_NAME_WIDTH = 18;
const COMMAND_NAME_GAP = 2;
const NARROW_FOOTER_COLS = 50;

export interface CommandCompletionRow {
  name: string;
  description: string;
  shortcut?: string | null;
}

interface CommandCompletionMenuProps {
  filtered: CommandCompletionRow[];
  selectedIndex: number;
  fuzzyMatch?: CommandCompletionRow | null;
  maxVisible: number;
}

export function CommandCompletionMenu({
  filtered,
  selectedIndex,
  fuzzyMatch,
  maxVisible,
}: CommandCompletionMenuProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const footer =
    cols < NARROW_FOOTER_COLS
      ? ['↑↓', '⏎', 'esc'].join(SOFT_SEP)
      : ['↑↓ select', 'tab fill', '⏎ run', 'esc close'].join(SOFT_SEP);

  return (
    <CompletionPanel
      items={filtered}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer={footer}
      isOpen
      itemKey={(cmd) => cmd.name}
      renderRow={({ item: cmd, isSelected, rowBg, visibleItems }) => {
        const nameWidth = getCommandNameWidth(visibleItems.map((item) => item.name));
        return <CommandRow cmd={cmd} isSelected={isSelected} rowBg={rowBg} nameWidth={nameWidth} />;
      }}
      renderEmpty={(panelBg) => {
        if (filtered.length > 0) return null;
        if (!fuzzyMatch) {
          return <Text color={t.textDim}>{`${NO_CURSOR}no matching commands`}</Text>;
        }
        const nameWidth = getCommandNameWidth([fuzzyMatch.name]);
        return (
          <AlignedOptionRow
            lead={<Text color={t.textDim}>{NO_CURSOR}</Text>}
            leadGap={0}
            label={fuzzyMatch.name}
            labelWidth={nameWidth}
            labelColor={t.textDim}
            detail={`${fuzzyMatch.description} (fuzzy)`}
            detailColor={t.textDim}
            backgroundColor={panelBg}
          />
        );
      }}
    />
  );
}

function getCommandNameWidth(names: string[]): number {
  return getAlignedOptionLabelWidth(names, {
    gap: COMMAND_NAME_GAP,
    maxWidth: MAX_COMMAND_NAME_WIDTH,
  });
}

function CommandRow({
  cmd,
  isSelected,
  rowBg,
  nameWidth,
}: {
  cmd: CommandCompletionRow;
  isSelected: boolean;
  rowBg: string;
  nameWidth: number;
}) {
  const t = useTheme();

  return (
    <Box width="100%" height={1} overflow="hidden" backgroundColor={rowBg}>
      <CursorCell isCursor={isSelected} dimWhenInactive />
      <Box width={nameWidth} flexShrink={0} overflow="hidden" backgroundColor={rowBg}>
        <Text color={isSelected ? t.accent : t.text} bold={isSelected} wrap="truncate-end">
          {cmd.name}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" backgroundColor={rowBg}>
        <Text color={t.textDim} wrap="truncate-end">
          {cmd.description}
        </Text>
      </Box>
      {cmd.shortcut ? (
        <Box flexShrink={0} marginLeft={1} backgroundColor={rowBg}>
          <Text color={t.textDim}>{cmd.shortcut}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
