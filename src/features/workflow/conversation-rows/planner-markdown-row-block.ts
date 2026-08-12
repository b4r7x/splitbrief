import type { Phase } from '../../../core/schemas/enums.js';
import type { ConversationRowBlock, ConversationRowTone } from './types.js';
import { row } from './row-format/rows.js';
import { compositeBlock, rowsBlock } from './row-block-compose.js';
import { markdownConversationRowsProjection } from './markdown-rows.js';

const LEADING_H1_HEADING_PATTERN = /^\s*#[^#].*(?:\r?\n)+/;

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// The planner often opens its first response by restating the feature title as a markdown H1 —
// redundant since the user's prompt already appears as the first row of the transcript. Strip that
// heading only when it actually echoes the title (the user's prompt), so a heading that introduces
// new content is kept. Matched on the title rather than block position, because the user_message
// prompt is always the first renderable block, so the planner's echo is never "first".
function stripEchoedTitleHeading(text: string, title: string | undefined): string {
  if (title === undefined || title === '') return text;
  const match = LEADING_H1_HEADING_PATTERN.exec(text);
  if (match === null) return text;
  const heading = match[0].replace(/^\s*#\s*/, '');
  if (normalizeHeading(heading) !== normalizeHeading(title)) return text;
  return text.slice(match[0].length);
}

export function markdownPlannerTextRowBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
  phase?: Phase;
  dedupTitle?: string | undefined;
}): ConversationRowBlock | null {
  const text = stripEchoedTitleHeading(input.text, input.dedupTitle);
  const projection = markdownConversationRowsProjection({
    keyPrefix: input.keyPrefix,
    text,
    width: input.width,
  });
  if (projection.rowCount === 0) return null;

  const markdownBlock: ConversationRowBlock = {
    key: input.keyPrefix,
    rowCount: projection.rowCount,
    renderableUnits: 1,
    createRows: projection.createRows,
  };

  const header = plannerPhaseHeader(input.phase);
  if (header === null) return markdownBlock;

  const headerRow = row({
    key: `${input.keyPrefix}-header`,
    text: header.label,
    tone: header.tone,
    bold: true,
    kind: 'message',
  });
  const headerBlock = rowsBlock(`${input.keyPrefix}-header-block`, [headerRow]);
  return compositeBlock(input.keyPrefix, [headerBlock, markdownBlock]);
}

// The artifact card names the artifact it wrote — Spec, Plan, Tasks, Research — in the same
// words and the same column. A bare phase header above it repeats the label without adding a
// fact, so the header gives way wherever a card covers the phase. Escalation has no card.
export function plannerPhaseHeader(
  phase: Phase | undefined,
): { label: string; tone: ConversationRowTone } | null {
  return phase === 'escalating' ? { label: 'Escalation', tone: 'warning' } : null;
}
