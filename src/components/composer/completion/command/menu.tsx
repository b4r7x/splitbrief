import { SOFT_SEP } from '../../../../core/separators.js';
import { CLOSE_HINT, formatKeyHints, SELECT_HINT } from '../../../key-legend.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CompletionList } from '../list.js';

const NARROW_FOOTER_COLS = 50;

export interface CommandCompletionRow {
  name: string;
  description: string;
  trailing?: string | null;
}

interface CommandCompletionMenuProps {
  filtered: CommandCompletionRow[];
  selectedIndex: number;
  fuzzyMatch?: CommandCompletionRow | null;
  maxVisible: number;
  width?: number | undefined;
  above?: boolean | undefined;
}

export function CommandCompletionMenu({
  filtered,
  selectedIndex,
  fuzzyMatch,
  maxVisible,
  width,
  above,
}: CommandCompletionMenuProps) {
  const cols = terminalSizeStore.use((s) => s.cols);
  const footer =
    cols < NARROW_FOOTER_COLS
      ? ['↑↓', '⏎', 'esc'].join(SOFT_SEP)
      : formatKeyHints([
          SELECT_HINT,
          { key: 'tab', verb: 'fill' },
          { key: '⏎', verb: 'run' },
          CLOSE_HINT,
        ]);
  const items = filtered.length
    ? filtered
    : fuzzyMatch
      ? [{ ...fuzzyMatch, description: `${fuzzyMatch.description} (fuzzy)` }]
      : [{ name: 'no matching commands' }];
  return (
    <CompletionList
      rows={items}
      selectedIndex={filtered.length ? selectedIndex : -1}
      maxVisible={maxVisible}
      footer={footer}
      width={width ?? cols}
      above={above}
    />
  );
}
