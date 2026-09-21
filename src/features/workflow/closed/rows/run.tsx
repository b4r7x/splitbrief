import { Text } from 'ink';
import type { Theme } from '../../../../components/theme.js';
import type { ScrollableDocumentRow } from '../../../../components/scrollable-document.js';
import type { CopySegment, RunRow } from '../copy.js';
import type { SummaryView } from '../view-model.js';
import { CREW_LABEL_WIDTH } from '../../../../core/crew/identity.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import { crewLine, runRows } from '../copy.js';
import { summaryToneColor } from '../tone.js';
import { LEDGER_LEAD, LEDGER_LEAD_CELLS, LedgerRule } from './lead.js';

/** The two spaces every labelled column on every other surface puts after its label. */
const LABEL_GAP = '  ';

export function runSectionRows(
  input: Readonly<{ view: SummaryView; width: number; theme: Theme; crewNamed: boolean }>,
): ScrollableDocumentRow[] {
  const { view, width, theme, crewNamed } = input;
  const valueWidth = Math.max(1, width - LEDGER_LEAD_CELLS - CREW_LABEL_WIDTH - LABEL_GAP.length);
  const rows: ScrollableDocumentRow[] = [
    { key: 'run-heading', node: <LedgerRule label="Run" width={width} /> },
  ];
  for (const row of [...crewRows(view, valueWidth, crewNamed), ...runRows(view)]) {
    rows.push({
      key: `run:${row.label}`,
      node: <RunValueRow row={row} theme={theme} width={valueWidth} />,
    });
  }
  return rows;
}

/** The crew is named once. This row exists only for the widths where the header could not seat it. */
function crewRows(view: SummaryView, budget: number, crewNamed: boolean): RunRow[] {
  if (crewNamed) return [];
  const line = crewLine(view, budget);
  return line === '' ? [] : [{ label: 'Crew', segments: [{ text: line, tone: 'text' }] }];
}

function RunValueRow({ row, theme, width }: { row: RunRow; theme: Theme; width: number }) {
  return (
    <Text wrap="truncate-end">
      <Text
        color={theme.text}
      >{`${LEDGER_LEAD}${row.label.padEnd(CREW_LABEL_WIDTH)}${LABEL_GAP}`}</Text>
      {fitSegments(row.segments, width).map((segment, index) => (
        <Text
          key={`${row.label}:${index}:${segment.text}`}
          color={summaryToneColor(segment.tone, theme)}
        >
          {index === 0 ? segment.text : `${SOFT_SEP}${segment.text}`}
        </Text>
      ))}
    </Text>
  );
}

/**
 * A value too wide for its column sheds whole ` · ` facts from the tail — half a fact states a
 * different fact — and the last one standing is cut from the middle so a path keeps both ends.
 */
function fitSegments(segments: readonly CopySegment[], budget: number): CopySegment[] {
  const kept = [...segments];
  while (kept.length > 1 && segmentCells(kept) > budget) kept.pop();
  if (segmentCells(kept) <= budget) return kept;
  const only = kept[0];
  if (only === undefined) return [];
  return [{ text: truncateTerminalDisplayTextMiddle(only.text, budget), tone: only.tone }];
}

function segmentCells(segments: readonly CopySegment[]): number {
  return getTerminalCellWidth(segments.map((segment) => segment.text).join(SOFT_SEP));
}
