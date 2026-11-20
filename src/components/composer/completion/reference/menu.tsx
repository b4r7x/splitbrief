import { SOFT_SEP } from '../../../../core/separators.js';
import { CLOSE_HINT, formatKeyHints, SELECT_HINT } from '../../../key-legend.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { CompletionList } from '../list.js';

const NARROW_FOOTER_COLS = 50;

interface ReferenceCompletionMenuProps {
  filtered: string[];
  selectedIndex: number;
  maxVisible: number;
  width?: number | undefined;
  above?: boolean | undefined;
}

export function ReferenceCompletionMenu({
  filtered,
  selectedIndex,
  maxVisible,
  width,
  above,
}: ReferenceCompletionMenuProps) {
  const cols = terminalSizeStore.use((s) => s.cols);
  const footer =
    cols < NARROW_FOOTER_COLS
      ? ['↑↓', '⏎', 'esc'].join(SOFT_SEP)
      : formatKeyHints([SELECT_HINT, { key: 'tab/⏎', verb: 'fill' }, CLOSE_HINT]);
  return (
    <CompletionList
      rows={filtered.map((name) => ({ name }))}
      selectedIndex={selectedIndex}
      maxVisible={maxVisible}
      footer={footer}
      width={width ?? cols}
      above={above}
    />
  );
}
