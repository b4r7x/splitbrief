import { Text } from 'ink';
import type { Theme } from '../../../../components/theme.js';
import type { ScrollableDocumentRow } from '../../../../components/scrollable-document.js';
import type { SummaryView } from '../view-model.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { configStore } from '../../../../stores/project/config.js';
import { osc8Hyperlink, terminalSupportsHyperlinks } from '../../../../lib/terminal/hyperlinks.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import { filePathUrl } from '../../../../utils/path-links.js';
import { filesRows } from '../copy.js';
import { summaryToneColor } from '../tone.js';
import { LEDGER_LEAD, LEDGER_LEAD_CELLS, LedgerRule } from './lead.js';

const PARTIAL = `${SOFT_SEP}partial`;

/**
 * What the run left on disk. Paths keep both ends when the column is short — the directory says
 * which subsystem moved, the file name says what did — and a path the run only half wrote says so
 * beside itself rather than being quietly listed as finished work.
 */
export function filesSectionRows(
  input: Readonly<{ view: SummaryView; width: number; theme: Theme }>,
): ScrollableDocumentRow[] {
  const { view, width, theme } = input;
  const projectDir = configStore.get().projectDir;
  const rows: ScrollableDocumentRow[] = [
    { key: 'files-heading', node: <LedgerRule label="Files" width={width} /> },
  ];
  for (const file of filesRows(view)) {
    const budget = Math.max(
      0,
      width - LEDGER_LEAD_CELLS - (file.partial ? getTerminalCellWidth(PARTIAL) : 0),
    );
    const label = truncateTerminalDisplayTextMiddle(file.path, budget);
    rows.push({
      key: `file:${file.path}`,
      node: (
        <Text wrap="truncate-end">
          {LEDGER_LEAD}
          <Text color={summaryToneColor('link', theme)}>
            {linkText({ label, path: file.path, projectDir })}
          </Text>
          {file.partial && <Text color={summaryToneColor('warning', theme)}>{PARTIAL}</Text>}
        </Text>
      ),
    });
  }
  return rows;
}

/** The transcript's rule: a path is clickable only where the terminal says so and a root is known. */
function linkText(input: Readonly<{ label: string; path: string; projectDir: string }>): string {
  const { label, path, projectDir } = input;
  if (projectDir === '' || !terminalSupportsHyperlinks()) return label;
  return osc8Hyperlink({ label, href: filePathUrl({ path, rootDir: projectDir }) });
}
