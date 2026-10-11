import { ThemeText as Text } from '../../../components/theme.js';
import { TextSpans } from '../../../components/text-spans.js';

import type { Theme } from '../../../core/theme/palette.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { colorForTone } from '../../../core/theme/tone-color.js';
import { glyph } from '../../../lib/glyphs.js';
import type { ConversationRowBlock } from '../conversation-rows/types.js';
import type { SummaryView } from './view-model.js';
import { filesRows } from './copy.js';
import { outcomeLeading, outcomeLineSpans, outcomeMarker } from './outcome.js';
import { briefsSectionRows } from './rows/briefs.js';
import { filesSectionRows } from './rows/files.js';
import { LEDGER_LEAD, LedgerRule } from './rows/lead.js';
import { runSectionRows } from './rows/run.js';

export interface ClosedBlockInput {
  /** Null when the run closed without leaving a record to read. */
  view: SummaryView | null;
  width: number;
  theme: Theme;
  /** Whether the header already names the whole crew, so the Run block does not name it twice. */
  crewNamed: boolean;
}

/**
 * The tail of a closed run's transcript: how it ended, then what it was asked to do, what it
 * changed and what it cost. Section order is fixed, and a section with nothing to list is absent
 * rather than a heading over an empty column.
 */
export function closedBlockRows(input: ClosedBlockInput): ScrollableDocumentRow[] {
  const { view, width, theme, crewNamed } = input;
  const rows: ScrollableDocumentRow[] = [
    { key: 'closed:heading', node: <LedgerRule label="Closed" width={width} /> },
  ];
  // A run opened from the list arrives with no transcript to read it from, so the block that
  // accounts for it says what it was asked to do before it says how that ended.
  if (view !== null) {
    rows.push({
      key: 'closed:feature',
      node: (
        <Text color={theme.text} wrap="truncate-end">
          {`${LEDGER_LEAD}${view.run.feature}`}
        </Text>
      ),
    });
  }
  rows.push({
    key: 'closed:outcome',
    node: <OutcomeLine view={view} width={width} theme={theme} />,
  });
  if (view === null) return rows;

  const sections: ScrollableDocumentRow[][] = [];
  if (view.briefs.rows.length > 0) {
    sections.push(briefsSectionRows({ view, width }));
  }
  if (view.briefs.earlierRows.length > 0) {
    sections.push(briefsSectionRows({ view, width, earlier: true }));
  }
  if (filesRows(view).length > 0) {
    sections.push(filesSectionRows({ view, width, theme }));
  }
  sections.push(runSectionRows({ view, width, theme, crewNamed }));

  for (const section of sections) {
    rows.push({ key: `closed:spacer:${rows.length}`, node: <Text> </Text> });
    rows.push(...section);
  }
  return rows;
}

/** The verdict uses the outcome tone; stage words keep their seat tone. */
function OutcomeLine({
  view,
  width,
  theme,
}: {
  view: SummaryView | null;
  width: number;
  theme: Theme;
}) {
  const marker: ReturnType<typeof outcomeMarker> =
    view === null ? { glyph: 'statusCancelled', tone: 'warning' } : outcomeMarker(view);
  const spans = outcomeLineSpans(view, width);
  return (
    <Text wrap="truncate-end">
      <Text color={colorForTone(marker.tone, theme)}>{outcomeLeading(glyph(marker.glyph))}</Text>
      <TextSpans
        parts={spans.map((span) => ({
          text: span.text,
          color:
            span.seat === undefined
              ? colorForTone(span.tone, theme)
              : theme[CREW_SEAT_ROLES[span.seat]],
        }))}
      />
    </Text>
  );
}

/**
 * The closed block as one transcript block. It is part of the transcript the run wrote — the same
 * scroller, below the last event — so a reader scrolls from the first planner word to the verdict
 * without changing surfaces. It counts as no renderable unit: it is not an event the run emitted.
 */
export function closedTranscriptBlock(input: ClosedBlockInput): ConversationRowBlock {
  const rows = closedBlockRows(input);
  const LEADING_BLANK = 1;
  return {
    key: 'closed-block',
    rowCount: rows.length + LEADING_BLANK,
    renderableUnits: 0,
    createRows: (windowStart, windowEnd) => {
      const out = [];
      for (let index = windowStart; index < windowEnd; index++) {
        const row = index < LEADING_BLANK ? undefined : rows[index - LEADING_BLANK];
        out.push({
          key: row?.key ?? `closed:blank:${index}`,
          kind: 'section' as const,
          segments: [],
          ...(row !== undefined && { node: row.node }),
        });
      }
      return out;
    },
  };
}
