import { Box, Text } from 'ink';
import { useTheme } from '../../../theme.js';
import type { RuntimeCommandDef } from '../../../../core/runtime/commands/types.js';
import {
  AlignedOptionRow,
  getAlignedOptionLabelWidth,
} from '../../../pickers/aligned-option-row.js';
import { CompletionPanel } from '../completion-panel.js';

const MAX_COMMAND_NAME_WIDTH = 18;
const COMMAND_NAME_GAP = 2;

interface CommandCompletionMenuProps {
  filtered: RuntimeCommandDef[];
  selectedIndex: number;
  fuzzyMatch?: RuntimeCommandDef | null;
  maxVisible: number;
}

export function CommandCompletionMenu({
  filtered,
  selectedIndex,
  fuzzyMatch,
  maxVisible,
}: CommandCompletionMenuProps) {
  const t = useTheme();

  return (
    <CompletionPanel
      items={filtered}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer="↑↓ select  Tab fill  Enter run  Esc close"
      isOpen={filtered.length > 0 || fuzzyMatch !== null}
      itemKey={(cmd) => cmd.name}
      renderRow={({ item: cmd, isSelected, rowBg, visibleItems }) => {
        const nameWidth = getCommandNameWidth(visibleItems.map((item) => item.name));
        return <CommandRow cmd={cmd} isSelected={isSelected} rowBg={rowBg} nameWidth={nameWidth} />;
      }}
      renderEmpty={(panelBg) => {
        if (!fuzzyMatch || filtered.length > 0) return null;
        const nameWidth = getCommandNameWidth([fuzzyMatch.name]);
        return (
          <Box width="100%" backgroundColor={panelBg} paddingX={1}>
            <AlignedOptionRow
              lead={<Text color={t.textDim}>{'▸'}</Text>}
              leadGap={1}
              label={fuzzyMatch.name}
              labelWidth={nameWidth}
              labelColor={t.textDim}
              detail={`${fuzzyMatch.description} (fuzzy)`}
              detailColor={t.textDim}
              backgroundColor={panelBg}
            />
          </Box>
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
  cmd: RuntimeCommandDef;
  isSelected: boolean;
  rowBg: string;
  nameWidth: number;
}) {
  const t = useTheme();
  const shortcut = cmd.shortcut ? `[${cmd.shortcut}]` : null;
  const details = shortcut ? `${cmd.description} ${shortcut}` : cmd.description;

  return (
    <AlignedOptionRow
      lead={<Text color={isSelected ? t.accent : t.textDim}>{isSelected ? '▸' : ' '}</Text>}
      leadGap={1}
      label={cmd.name}
      labelWidth={nameWidth}
      labelColor={isSelected ? t.accent : t.text}
      labelBold={isSelected}
      detail={details}
      detailColor={t.textDim}
      detailWrap={shortcut ? 'truncate-middle' : 'truncate-end'}
      backgroundColor={rowBg}
    />
  );
}
