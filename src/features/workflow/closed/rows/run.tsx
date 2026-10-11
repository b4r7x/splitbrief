import { ThemeText as Text } from '../../../../components/theme.js';

import type { Theme } from '../../../../core/theme/palette.js';
import type { ScrollableDocumentRow } from '../../../../components/scrollable-document.js';
import type { CopySegment, RunRow } from '../copy.js';
import type { SummaryView } from '../view-model.js';
import { CREW_LABEL_WIDTH } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { colorForTone } from '../../../../core/theme/tone-color.js';
import {
  getTerminalCellWidth,
  ELLIPSIS,
  segmentsForRowText,
  stripTerminalControls,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import { crewLine, factSpans, runRows } from '../copy.js';
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
  const segments = line.flatMap((span) =>
    span.seat === undefined ? [] : [{ text: span.text, tone: CREW_SEAT_ROLES[span.seat] }],
  );
  return segments.length === 0 ? [] : [{ label: 'Crew', segments }];
}

function RunValueRow({ row, theme, width }: { row: RunRow; theme: Theme; width: number }) {
  return (
    <Text wrap="truncate-end">
      <Text color={theme.text}>
        {LEDGER_LEAD}
        <Text color={row.seat === undefined ? theme.text : theme[CREW_SEAT_ROLES[row.seat]]}>
          {row.label}
        </Text>
        {`${row.label.padEnd(CREW_LABEL_WIDTH).slice(row.label.length)}${LABEL_GAP}`}
      </Text>
      {fitSegments(row.segments, width).map((segment, index) => (
        <Text
          key={`${row.label}:${index}:${segment.text}`}
          color={colorForTone(segment.tone, theme)}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * A value too wide for its column sheds whole ` · ` facts from the tail — half a fact states a
 * different fact — and the last one standing is cut from the middle so a path keeps both ends.
 */
function fitSegments(facts: RunRow['segments'], budget: number): CopySegment[] {
  const kept = facts.map(factSpans);
  while (kept.length > 1 && segmentCells(kept) > budget) kept.pop();
  if (segmentCells(kept) <= budget) {
    return kept.flatMap((fact, index) => [
      ...(index > 0 ? [{ text: SOFT_SEP, tone: 'textDim' } satisfies CopySegment] : []),
      ...fact,
    ]);
  }
  const only = kept[0];
  if (only === undefined) return [];
  const clean = only.map((span) => ({ ...span, text: stripTerminalControls(span.text) }));
  const text = clean.map((span) => span.text).join('');
  const fitted = truncateTerminalDisplayTextMiddle(text, budget);
  const head = truncateTerminalDisplayText(text, Math.floor((budget - 1) / 2) + 1).slice(
    0,
    -ELLIPSIS.length,
  );
  const tail = fitted.slice(head.length + ELLIPSIS.length);
  return [
    ...segmentsForRowText(clean, head),
    ...segmentsForRowText(clean, ELLIPSIS, head.length),
    ...segmentsForRowText(clean, tail, text.length - tail.length),
  ];
}

function segmentCells(facts: readonly (readonly CopySegment[])[]): number {
  return getTerminalCellWidth(
    facts.map((fact) => fact.map((span) => span.text).join('')).join(SOFT_SEP),
  );
}
